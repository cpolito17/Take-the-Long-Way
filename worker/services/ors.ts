// OpenRouteService directions client (spec §3). Mirrors
// backend/app/services/ors.py.

import { DEFAULTS, userAgent } from "../config";
import { ApiError, type Env, type RouteInfo } from "../types";

const M_PER_MI = 1609.344;

// coordinates: [[lng, lat], ...] origin → (stops) → destination.
export async function route(env: Env, coordinates: number[][]): Promise<RouteInfo> {
  if (!env.ORS_API_KEY) throw new ApiError(500, "ORS_API_KEY is not configured");
  const url = `${env.ORS_BASE_URL || DEFAULTS.ORS_BASE_URL}/v2/directions/driving-car/geojson`;
  const r = await fetch(url, {
    method: "POST",
    body: JSON.stringify({ coordinates }),
    headers: {
      Authorization: env.ORS_API_KEY,
      "Content-Type": "application/json",
      "User-Agent": userAgent(env),
    },
  });
  if (r.status !== 200) {
    let detail = "Routing failed";
    try {
      const body = (await r.json()) as { error?: { message?: string } };
      detail = body?.error?.message || detail;
    } catch { /* keep default */ }
    throw new ApiError(502, `OpenRouteService error (${r.status}): ${detail}`);
  }
  const body = (await r.json()) as {
    features: { geometry: { coordinates: [number, number][] }; properties: { summary: { distance: number; duration: number } } }[];
  };
  const feature = body.features[0];
  const summary = feature.properties.summary;
  return {
    coordinates: feature.geometry.coordinates,
    distance_mi: Math.round((summary.distance / M_PER_MI) * 10) / 10,
    duration_min: Math.round((summary.duration / 60.0) * 10) / 10,
  };
}
