// The per-search filtering pipeline (spec §5). Mirrors backend/app/search.py:
// route → bbox candidates (cache + live) → corridor filter → detour →
// keyword/source filter → de-dup → de-cluster → sorted, soft-capped.

import { ALL_SOURCES, CACHED_SOURCES } from "./config";
import { dedupe } from "./dedupe";
import { decluster, RouteCorridor } from "./geo";
import * as ors from "./services/ors";
import * as overpass from "./services/overpass";
import * as wikipedia from "./services/wikipedia";
import * as store from "./store";
import type { Env, Place, RouteInfo, SearchRequest } from "./types";

// Default-ranking confidence per source: how much we trust the score as a
// "people actually love this place" signal. Atlas Obscura's want-to-go /
// been-here counts are real traveler interest; HMDb's flat curated baseline
// is not, so it fills in rather than leads.
const SOURCE_CONFIDENCE: Record<string, number> = {
  atlas_obscura: 1.0,
  roadside_america: 0.95,
  wikipedia: 0.85,
  wikidata: 0.80,
  osm: 0.72,
  hmdb: 0.58,
};

// Max rank penalty for sitting at the far edge of the corridor — favors
// closer-to-route results without hard-excluding the edge.
const PROXIMITY_PENALTY = 14.0;

function rank(p: Place, radiusMi: number): number {
  const srcs = p.sources.length ? p.sources : [p.source];
  const conf = Math.max(...srcs.map((s) => SOURCE_CONFIDENCE[s] ?? 0.7));
  const proximity = PROXIMITY_PENALTY * ((p.offset_mi || 0.0) / radiusMi);
  return Math.round((p.score * conf - proximity) * 10) / 10;
}

function keywordMatch(p: Place, keyword: string): boolean {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return true;
  const hay = [p.name, p.description, p.tags.join(" "), p.category].join(" ").toLowerCase();
  return kw.split(/\s+/).every((token) => hay.includes(token));
}

export interface SearchResponse {
  route: RouteInfo;
  places: Place[];
  total_candidates: number;
}

export async function runSearch(env: Env, req: SearchRequest): Promise<SearchResponse> {
  const radiusMi = req.radius_mi ?? 25.0;
  const requested = new Set((req.sources ?? []).filter((s) => ALL_SOURCES.has(s)));
  const enabled = requested.size ? requested : ALL_SOURCES;

  // 1. Route from ORS.
  const route = await ors.route(env, req.waypoints.map((w) => [w.lng, w.lat]));
  const corridor = new RouteCorridor(route.coordinates);

  // 2. Gather candidates: D1 cache + live sources, in parallel.
  const tasks: Promise<Place[]>[] = [];
  if (enabled.has("osm")) {
    tasks.push(overpass.fetchPlaces(env, corridor.segmentBboxes(radiusMi)));
  }
  if (enabled.has("wikipedia")) {
    // Sample spacing ~ the geosearch radius (10 km ≈ 6.2 mi) so coverage is
    // continuous along the line.
    tasks.push(wikipedia.fetchPlaces(env, corridor.samplePoints(11.0)));
  }
  const cachedEnabled = new Set([...enabled].filter((s) => CACHED_SOURCES.has(s)));
  if (cachedEnabled.size) {
    tasks.push(store.queryBbox(env.DB, corridor.bbox(radiusMi), cachedEnabled));
  }
  const candidates = (await Promise.all(tasks)).flat();

  // 3. Corridor filter + position along route.
  const inCorridor: Place[] = [];
  for (const p of candidates) {
    const [offset, along] = corridor.offsetAndAlong(p.lng, p.lat);
    if (offset <= radiusMi) {
      p.offset_mi = Math.round(offset * 10) / 10;
      p.along_mi = Math.round(along * 10) / 10;
      // 4. Cheap detour approximation (spec allows).
      [p.detour_mi, p.detour_min] = RouteCorridor.detour(offset);
      inCorridor.push(p);
    }
  }

  // 5. Keyword filter (sources already filtered at gather time).
  const filtered = inCorridor.filter((p) => keywordMatch(p, req.keyword ?? ""));

  // De-dup live results against cached ones, then rank.
  const merged = dedupe(filtered);
  for (const p of merged) p.rank = rank(p, radiusMi);

  // 6–7. de-cluster and cap (by rank).
  const final = decluster(merged, corridor.lengthMi);

  console.log(
    `search: ${candidates.length} candidates → ${inCorridor.length} in corridor → ` +
    `${merged.length} after filters → ${final.length} returned`
  );
  return { route, places: final, total_candidates: merged.length };
}
