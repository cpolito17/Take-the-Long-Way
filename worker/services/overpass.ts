// OpenStreetMap via Overpass — live per query (spec §4). Mirrors
// backend/app/services/overpass.py: a curated slice of community-tagged
// oddities (tourism/historic tags) inside bboxes tiled along the route
// corridor, never one huge box.

import { categorize } from "../categories";
import { DEFAULTS, userAgent } from "../config";
import * as scoring from "../scoring";
import type { Env, Place } from "../types";

// Tag values that match the "quirky deep cuts" brief; deliberately excludes
// generic tourism (hotels, viewpoints, info boards) and ubiquitous
// historic=memorial.
const NODE_FILTERS = [
  '["tourism"~"^(attraction|artwork)$"]["name"]',
  '["historic"~"^(ruins|fort|wreck|ship|aircraft|locomotive|mine|battlefield|archaeological_site)$"]["name"]',
];

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string>;
}

function buildQuery(bboxes: [number, number, number, number][]): string {
  const parts: string[] = [];
  for (const [minLng, minLat, maxLng, maxLat] of bboxes) {
    const bbox = `(${minLat.toFixed(4)},${minLng.toFixed(4)},${maxLat.toFixed(4)},${maxLng.toFixed(4)})`;
    for (const flt of NODE_FILTERS) {
      parts.push(`node${flt}${bbox};`);
      parts.push(`way${flt}${bbox};`);
    }
  }
  return `[out:json][timeout:50];\n(\n${parts.join("\n")}\n);\nout center tags 900;`;
}

function elementToPlace(el: OverpassElement): Place | null {
  const tags = el.tags ?? {};
  const name = tags["name"];
  if (!name) return null;
  const lat = el.type === "node" ? el.lat : el.center?.lat;
  const lng = el.type === "node" ? el.lon : el.center?.lon;
  if (lat == null || lng == null) return null;
  const hasWiki = "wikipedia" in tags || "wikidata" in tags;
  const desc = tags["description"] || (tags["inscription"] || "").slice(0, 200);
  const image = (tags["image"] || "").startsWith("http") ? tags["image"] : null;
  const tagList = Object.entries(tags)
    .filter(([k]) => ["tourism", "historic", "artwork_type", "ruins", "man_made"].includes(k))
    .map(([k, v]) => `${k}=${v}`);
  const score = scoring.universalBoosts(
    scoring.osm(Object.keys(tags).length, hasWiki), Boolean(image), desc
  );
  const wp = tags["wikipedia"];
  const url = wp && wp.includes(":")
    ? `https://en.wikipedia.org/wiki/${wp.split(/:(.*)/)[1]}`
    : `https://www.openstreetmap.org/${el.type}/${el.id}`;
  return {
    id: `osm:${el.type}/${el.id}`,
    name,
    description: desc,
    category: categorize(tagList, name, desc),
    source: "osm",
    sources: [],
    source_url: url,
    lat,
    lng,
    image_url: image,
    score,
    tags: tagList,
  };
}

export async function fetchPlaces(
  env: Env, bboxes: [number, number, number, number][]
): Promise<Place[]> {
  const query = buildQuery(bboxes);
  let elements: OverpassElement[];
  try {
    const r = await fetch(env.OVERPASS_URL || DEFAULTS.OVERPASS_URL, {
      method: "POST",
      body: new URLSearchParams({ data: query }),
      headers: { "User-Agent": userAgent(env) },
    });
    if (!r.ok) throw new Error(`status ${r.status}`);
    elements = ((await r.json()) as { elements?: OverpassElement[] }).elements ?? [];
  } catch (e) {
    console.warn(`Overpass query failed (continuing without OSM): ${e}`);
    return [];
  }
  const places: Place[] = [];
  const seen = new Set<string>();
  for (const el of elements) {
    const p = elementToPlace(el);
    if (p && !seen.has(p.id)) {
      seen.add(p.id);
      places.push(p);
    }
  }
  return places;
}
