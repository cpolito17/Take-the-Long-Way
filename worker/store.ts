// Thin data-access wrapper over the D1 place cache (spec §3: thin so a
// source can move between cached and live without a rewrite). Mirrors
// backend/app/store.py; the Python pipeline builds the data, `wrangler d1
// execute --file` loads it.

import type { Place } from "./types";

interface PlaceRow {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  source: string;
  sources: string | null;
  source_url: string | null;
  lat: number;
  lng: number;
  image_url: string | null;
  score: number | null;
  tags: string | null;
}

function rowToPlace(row: PlaceRow): Place {
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    category: row.category || "Other",
    source: row.source,
    sources: JSON.parse(row.sources || "[]"),
    source_url: row.source_url || "",
    lat: row.lat,
    lng: row.lng,
    image_url: row.image_url,
    score: row.score || 0.0,
    tags: JSON.parse(row.tags || "[]"),
  };
}

// All cached places inside (min_lng, min_lat, max_lng, max_lat), optionally
// limited to a set of primary sources.
export async function queryBbox(
  db: D1Database,
  bbox: [number, number, number, number],
  sources?: Set<string>
): Promise<Place[]> {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  let sql = "SELECT * FROM places WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?";
  const args: (number | string)[] = [minLat, maxLat, minLng, maxLng];
  if (sources && sources.size) {
    sql += ` AND source IN (${[...sources].map(() => "?").join(",")})`;
    args.push(...sources);
  }
  const { results } = await db.prepare(sql).bind(...args).all<PlaceRow>();
  return results.map(rowToPlace);
}

export async function stats(db: D1Database): Promise<Record<string, number>> {
  try {
    const { results } = await db
      .prepare("SELECT source, COUNT(*) AS n FROM places GROUP BY source")
      .all<{ source: string; n: number }>();
    return Object.fromEntries(results.map((r) => [r.source, r.n]));
  } catch {
    return {};
  }
}
