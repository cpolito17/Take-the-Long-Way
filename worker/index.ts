// Take the Long Way — Cloudflare Worker. Serves the JSON API under
// /takethelongway/api/* and the static frontend for everything else under
// /takethelongway/. Port of backend/app/main.py (the FastAPI reference
// implementation, kept in backend/).

import { buildLinks } from "./gmaps";
import { ALL_SOURCES } from "./config";
import { RouteCorridor } from "./geo";
import { runSearch } from "./search";
import * as nominatim from "./services/nominatim";
import * as ors from "./services/ors";
import * as store from "./store";
import {
  ApiError,
  type Env,
  type FinalizeRequest,
  type SearchRequest,
  type SelectedStop,
  type Waypoint,
} from "./types";

const BASE = "/takethelongway";
const MAX_JSON_BYTES = 64 * 1024;
const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' https://unpkg.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' https://basemaps.cartocdn.com https://*.basemaps.cartocdn.com; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
};

function secure(response: Response): Response {
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) secured.headers.set(name, value);
  return secured;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isWaypoint(w: unknown): w is Waypoint {
  const x = w as Waypoint;
  return typeof x === "object" && x !== null &&
    typeof x.lat === "number" && Number.isFinite(x.lat) && x.lat >= -90 && x.lat <= 90 &&
    typeof x.lng === "number" && Number.isFinite(x.lng) && x.lng >= -180 && x.lng <= 180;
}

async function readJson<T>(request: Request): Promise<T> {
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    throw new ApiError(415, "Content-Type must be application/json");
  }
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_JSON_BYTES) throw new ApiError(413, "Request body is too large");
  if (!request.body) throw new ApiError(400, "Request body must be valid JSON");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_JSON_BYTES) {
      await reader.cancel();
      throw new ApiError(413, "Request body is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new ApiError(400, "Request body must be valid JSON");
  }
}

function validWaypoints(waypoints: unknown): Waypoint[] {
  if (!Array.isArray(waypoints) || waypoints.length < 2 || waypoints.length > 8 ||
    !waypoints.every(isWaypoint)) {
    throw new ApiError(422, "waypoints must be 2–8 {lat, lng} points");
  }
  return waypoints;
}

async function handleSearch(env: Env, request: Request): Promise<Response> {
  const body = await readJson<SearchRequest>(request);
  validWaypoints(body.waypoints);
  const radius = body.radius_mi ?? 25.0;
  if (typeof radius !== "number" || radius < 5.0 || radius > 75.0) {
    throw new ApiError(422, "radius_mi must be between 5 and 75");
  }
  if (body.keyword != null && (typeof body.keyword !== "string" || body.keyword.length > 120)) {
    throw new ApiError(422, "keyword must be at most 120 characters");
  }
  if (body.sources != null && (!Array.isArray(body.sources) || body.sources.length > 6 ||
    !body.sources.every((source) => typeof source === "string" && ALL_SOURCES.has(source)))) {
    throw new ApiError(422, "sources must be a list of supported source names");
  }
  return json(await runSearch(env, body));
}

// Trip stats + Google Maps links: baseline route (user waypoints only) vs.
// the route with all selected stops inserted in along-route order.
async function handleFinalize(env: Env, request: Request): Promise<Response> {
  const body = await readJson<FinalizeRequest>(request);
  const waypoints = validWaypoints(body.waypoints);
  const stops = body.stops;
  if (!Array.isArray(stops) || stops.length < 1 || stops.length > 45 || !stops.every(isWaypoint)) {
    throw new ApiError(422, "stops must be a list of 1–45 valid {lat, lng} points");
  }

  const baseCoords = waypoints.map((w) => [w.lng, w.lat]);
  const baseline = await ors.route(env, baseCoords);
  const corridor = new RouteCorridor(baseline.coordinates);

  // Order every intermediate point (user stops + selected places) by its
  // position along the baseline route.
  const along = new Map<object, number>();
  for (const pt of [...stops, ...waypoints]) {
    along.set(pt, corridor.offsetAndAlong(pt.lng, pt.lat)[1]);
  }
  const byAlong = (a: object, b: object) => along.get(a)! - along.get(b)!;

  const orderedStops = [...stops].sort(byAlong);
  const middles: { lng: number; lat: number }[] = [
    ...waypoints.slice(1, -1),
    ...orderedStops,
  ].sort(byAlong);

  const fullCoords = [baseCoords[0], ...middles.map((m) => [m.lng, m.lat]), baseCoords[baseCoords.length - 1]];
  if (fullCoords.length > 50) {
    throw new ApiError(400, "Too many stops for a single trip (limit ~45).");
  }
  const tripRoute = await ors.route(env, fullCoords);

  const points = fullCoords.map(([lng, lat]) => [lat, lng] as [number, number]);
  return json({
    route: tripRoute,
    ordered_stops: orderedStops as SelectedStop[],
    baseline: { distance_mi: baseline.distance_mi, duration_min: baseline.duration_min },
    trip: { distance_mi: tripRoute.distance_mi, duration_min: tripRoute.duration_min },
    added_mi: Math.round((tripRoute.distance_mi - baseline.distance_mi) * 10) / 10,
    added_min: Math.round((tripRoute.duration_min - baseline.duration_min) * 10) / 10,
    maps_links: buildLinks(points),
  });
}

async function handleApi(env: Env, request: Request, path: string): Promise<Response> {
  if (path === "/api/health" && request.method === "GET") {
    return json({
      status: "ok",
      cache: await store.stats(env.DB),
      ors_key_configured: Boolean(env.ORS_API_KEY),
    });
  }
  if (path === "/api/geocode" && request.method === "GET") {
    const q = new URL(request.url).searchParams.get("q") ?? "";
    if (q.length < 2 || q.length > 200) throw new ApiError(422, "q must be 2–200 characters");
    return json(await nominatim.search(env, q));
  }
  if (path === "/api/search" && request.method === "POST") {
    return handleSearch(env, request);
  }
  if (path === "/api/finalize" && request.method === "POST") {
    return handleFinalize(env, request);
  }
  throw new ApiError(404, "Not found");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Bare path → trailing slash, so the frontend's relative URLs resolve.
    if (url.pathname === BASE) {
      url.pathname = BASE + "/";
      return secure(Response.redirect(url.toString(), 301));
    }
    if (!url.pathname.startsWith(BASE + "/")) {
      // Local dev convenience: `wrangler dev` serves at the root.
      url.pathname = BASE + url.pathname;
      return secure(Response.redirect(url.toString(), 302));
    }

    const path = url.pathname.slice(BASE.length);
    if (path.startsWith("/api/")) {
      if (request.headers.get("sec-fetch-site") === "cross-site") {
        return secure(json({ detail: "Cross-site requests are not allowed" }, 403));
      }
      try {
        const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
        const limiter = path === "/api/geocode" ? env.GEOCODE_LIMITER :
          path === "/api/search" || path === "/api/finalize" ? env.ROUTE_LIMITER : null;
        if (limiter) {
          const outcome = await limiter.limit({ key: ip });
          if (!outcome.success) {
            const response = secure(json({ detail: "Too many requests. Please wait a minute." }, 429));
            response.headers.set("Retry-After", "60");
            return response;
          }
        }
        return secure(await handleApi(env, request, path));
      } catch (e) {
        if (e instanceof ApiError) return secure(json({ detail: e.detail }, e.status));
        console.error(e);
        return secure(json({ detail: "Internal error" }, 500));
      }
    }

    // Static frontend: strip the base prefix and serve from the assets dir.
    const assetUrl = new URL(url);
    assetUrl.pathname = path === "/" ? "/index.html" : path;
    return secure(await env.ASSETS.fetch(new Request(assetUrl.toString(), request)));
  },
};
