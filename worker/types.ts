// API request/response shapes and the unified place record (spec §4).
// Mirrors backend/app/models.py.

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  TTLW_CONTACT?: string;
  ORS_API_KEY?: string;
  ORS_BASE_URL?: string;
  NOMINATIM_URL?: string;
  OVERPASS_URL?: string;
  WIKIPEDIA_API_URL?: string;
}

export interface Place {
  id: string;
  name: string;
  description: string;
  category: string;
  source: string;
  sources: string[];
  source_url: string;
  lat: number;
  lng: number;
  image_url: string | null;
  score: number;
  tags: string[];
  // Per-query fields, filled in during a search.
  offset_mi?: number | null;
  detour_mi?: number | null;
  detour_min?: number | null;
  along_mi?: number | null;
  rank?: number | null;
}

export interface Waypoint {
  name?: string;
  lat: number;
  lng: number;
}

export interface SearchRequest {
  waypoints: Waypoint[];
  radius_mi?: number;
  keyword?: string;
  sources?: string[];
}

export interface RouteInfo {
  coordinates: [number, number][]; // [lng, lat] pairs
  distance_mi: number;
  duration_min: number;
}

export interface SelectedStop {
  id: string;
  name: string;
  lat: number;
  lng: number;
  category?: string;
  detour_mi?: number | null;
  detour_min?: number | null;
}

export interface FinalizeRequest {
  waypoints: Waypoint[];
  stops: SelectedStop[];
}

export interface MapsLink {
  label: string;
  url: string;
}

// FastAPI's HTTPException equivalent: carries a status code and a `detail`
// message the frontend surfaces to the user.
export class ApiError extends Error {
  constructor(public status: number, public detail: string) {
    super(detail);
  }
}
