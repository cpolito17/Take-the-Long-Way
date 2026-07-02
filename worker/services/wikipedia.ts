// Wikipedia Geosearch — live per query (spec §4). Mirrors
// backend/app/services/wikipedia.py: articles with marked coordinates near
// the route, with pageviews as the popularity signal. Geosearch radius is
// capped at 10 km, so we sample points along the route and run one
// generator=geosearch query per point. Plain settlement/admin articles are
// filtered out — they're the opposite of the deep cuts this app exists for.

import { categorize } from "../categories";
import { DEFAULTS, userAgent } from "../config";
import * as scoring from "../scoring";
import type { Env, Place } from "../types";

// Article descriptions that mark "ordinary place" pages, not quirky stops.
const BORING_RE = new RegExp(
  "(city|town|village|borough|township|hamlet|census[- ]designated|" +
  "unincorporated community|county in|neighborhood|suburb|" +
  "school district|public school|high school|elementary school|" +
  "middle school|university|college|" +
  "interstate|u\\.s\\.? (route|highway)|state (route|highway)|freeway|" +
  "expressway|toll road|" +
  "airport|railway station|train station|transit|bus station|" +
  "shopping (mall|center|centre)|supermarket|radio station|" +
  "television station|sports venue|stadium|arena|" +
  "area code|telephone|zip code|postal code|" +
  "office building|office tower|office complex|office park|" +
  "headquarters|skyscraper|high-rise|corporate|" +
  "company|corporation|business(es)? |conglomerate|subsidiary|" +
  "hospital|medical center|clinic|nursing home|" +
  "hotel|motel chain|apartment|residential|condominium|housing|" +
  "golf course|country club|" +
  "power (plant|station)|substation|water treatment|sewage|landfill|" +
  "industrial park|distribution center|warehouse|" +
  "city hall|courthouse annex|government building|administrative|" +
  "post office|think tank|advocacy group|nonprofit|non-profit|" +
  "organization|federally recognized|tribe|" +
  "human settlement|populated place|settlement in|" +
  "^place in )",
  "i"
);

// Meta-articles that carry coordinates but aren't places at all.
const BORING_TITLE_RE = new RegExp(
  "^(area codes? |list of |lists of |demographics of |timeline of |" +
  "index of |history of |geography of |climate of |economy of )",
  "i"
);

const MAX_POINTS = 30; // keeps very long routes to a sane number of API calls
const CONCURRENCY = 6;

interface WikiPage {
  pageid: number;
  title: string;
  description?: string;
  pageviews?: Record<string, number | null>;
  thumbnail?: { source?: string };
  coordinates?: { lat?: number; lon?: number }[];
}

async function geosearchAt(env: Env, lng: number, lat: number): Promise<WikiPage[]> {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "geosearch",
    ggscoord: `${lat}|${lng}`,
    ggsradius: "10000",
    ggslimit: "40",
    prop: "description|pageviews|pageimages|coordinates",
    piprop: "thumbnail",
    pithumbsize: "480",
    colimit: "max",
  });
  try {
    const r = await fetch(`${env.WIKIPEDIA_API_URL || DEFAULTS.WIKIPEDIA_API_URL}?${params}`, {
      headers: { "User-Agent": userAgent(env) },
    });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const body = (await r.json()) as { query?: { pages?: Record<string, WikiPage> } };
    return Object.values(body.query?.pages ?? {});
  } catch (e) {
    console.warn(`Wikipedia geosearch failed at ${lat.toFixed(3)},${lng.toFixed(3)}: ${e}`);
    return [];
  }
}

function pageToPlace(page: WikiPage): Place | null {
  const coords = page.coordinates?.[0] ?? {};
  const lat = coords.lat, lng = coords.lon;
  if (lat == null || lng == null) return null;
  const title = page.title;
  const desc = page.description || "";
  if (!desc || BORING_RE.test(desc) || BORING_TITLE_RE.test(title)) return null;
  const views = Object.values(page.pageviews ?? {}).reduce<number>((a, v) => a + (v || 0), 0);
  const thumb = page.thumbnail?.source ?? null;
  const score = scoring.universalBoosts(scoring.wikipedia(views), Boolean(thumb), desc);
  return {
    id: `wp:${page.pageid}`,
    name: title,
    description: desc ? desc[0].toUpperCase() + desc.slice(1) : "",
    category: categorize([], title, desc),
    source: "wikipedia",
    sources: [],
    source_url: `https://en.wikipedia.org/?curid=${page.pageid}`,
    lat,
    lng,
    image_url: thumb,
    score,
    tags: [],
  };
}

export async function fetchPlaces(
  env: Env, samplePoints: [number, number][]
): Promise<Place[]> {
  let points = samplePoints;
  if (points.length > MAX_POINTS) {
    const step = points.length / MAX_POINTS;
    points = Array.from({ length: MAX_POINTS }, (_, i) => samplePoints[Math.floor(i * step)]);
  }
  // Bounded concurrency, like the Python semaphore(6).
  const results: WikiPage[][] = [];
  for (let i = 0; i < points.length; i += CONCURRENCY) {
    const chunk = points.slice(i, i + CONCURRENCY);
    results.push(...(await Promise.all(chunk.map(([lng, lat]) => geosearchAt(env, lng, lat)))));
  }
  const places = new Map<string, Place>();
  for (const pages of results) {
    for (const page of pages) {
      const p = pageToPlace(page);
      if (p && !places.has(p.id)) places.set(p.id, p);
    }
  }
  return [...places.values()];
}
