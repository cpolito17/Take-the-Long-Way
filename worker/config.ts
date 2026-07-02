// Central configuration, mirrors backend/app/config.py. Values come from
// Worker vars/secrets with the same defaults so behavior matches the
// reference Python implementation.

import type { Env } from "./types";

export const DEFAULTS = {
  ORS_BASE_URL: "https://api.openrouteservice.org",
  NOMINATIM_URL: "https://nominatim.openstreetmap.org",
  OVERPASS_URL: "https://overpass-api.de/api/interpreter",
  WIKIPEDIA_API_URL: "https://en.wikipedia.org/w/api.php",
};

export function userAgent(env: Env): string {
  const contact = env.TTLW_CONTACT || "set-TTLW_CONTACT-var";
  return `TakeTheLongWayBot/1.0 (self-hosted road-trip planner; contact: ${contact}) cloudflare-worker`;
}

// Soft result target (spec §3: feel-based, not a hard cap).
export const RESULT_TARGET = 100;

// Cheap detour approximation knobs (spec §5 step 4 allows approximation).
export const ROAD_CIRCUITY = 1.35;
export const DETOUR_AVG_MPH = 35.0;

export const CACHED_SOURCES = new Set(["atlas_obscura", "roadside_america", "wikidata", "hmdb"]);
export const LIVE_SOURCES = new Set(["osm", "wikipedia"]);
export const ALL_SOURCES = new Set([...CACHED_SOURCES, ...LIVE_SOURCES]);
