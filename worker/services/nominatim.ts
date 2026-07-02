// Nominatim geocoding proxy (spec §3). Mirrors
// backend/app/services/nominatim.py: proxied through the Worker so the
// browser never hits the public endpoint directly (consistent User-Agent,
// no CORS issues). The frontend debounces; we keep requests minimal.

import { DEFAULTS, userAgent } from "../config";
import { ApiError, type Env } from "../types";

interface NominatimItem {
  display_name?: string;
  lat: string;
  lon: string;
}

export async function search(
  env: Env, q: string, limit = 5
): Promise<{ name: string; lat: number; lng: number }[]> {
  const params = new URLSearchParams({
    q,
    format: "jsonv2",
    countrycodes: "us",
    limit: String(limit),
    addressdetails: "0",
  });
  const r = await fetch(`${env.NOMINATIM_URL || DEFAULTS.NOMINATIM_URL}/search?${params}`, {
    headers: { "User-Agent": userAgent(env) },
  });
  if (!r.ok) throw new ApiError(502, `Geocoding failed (${r.status})`);
  const items = (await r.json()) as NominatimItem[];
  return items.map((item) => ({
    name: item.display_name || "",
    lat: parseFloat(item.lat),
    lng: parseFloat(item.lon),
  }));
}
