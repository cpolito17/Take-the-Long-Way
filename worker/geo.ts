// Route-corridor geometry: buffer filtering, detour approximation, spatial
// de-clustering. Mirrors backend/app/geo.py, with shapely replaced by a
// Douglas-Peucker simplification + per-segment projection math.
//
// Internally we work in a local equirectangular projection measured in
// miles, which is plenty accurate for corridor-width filtering at US scales.

import { DETOUR_AVG_MPH, RESULT_TARGET, ROAD_CIRCUITY } from "./config";
import type { Place } from "./types";

const MI_PER_DEG_LAT = 69.0;

type Pt = [number, number]; // (x, y) in miles

function perpDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// Douglas-Peucker, iterative to be safe on very long polylines.
function simplify(pts: Pt[], tolerance: number): Pt[] {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    let maxD = 0, maxI = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDist(pts[i], pts[lo], pts[hi]);
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > tolerance && maxI > 0) {
      keep[maxI] = 1;
      stack.push([lo, maxI], [maxI, hi]);
    }
  }
  return pts.filter((_, i) => keep[i] === 1);
}

export class RouteCorridor {
  refLat: number;
  miPerDegLng: number;
  pts: Pt[]; // simplified polyline in mile-space
  cum: number[]; // cumulative length at each vertex
  lengthMi: number;

  // coordinates: route polyline as [lng, lat] pairs.
  constructor(coordinates: [number, number][]) {
    const lats = coordinates.map((c) => c[1]);
    this.refLat = lats.reduce((a, b) => a + b, 0) / lats.length;
    this.miPerDegLng = MI_PER_DEG_LAT * Math.cos((this.refLat * Math.PI) / 180);
    const raw: Pt[] = coordinates.map((c) => this.toMi(c[0], c[1]));
    // Simplify to keep per-candidate distance checks fast on long routes;
    // 0.5 mi tolerance is far below any usable corridor radius.
    this.pts = simplify(raw, 0.5);
    this.cum = [0];
    for (let i = 1; i < this.pts.length; i++) {
      const [ax, ay] = this.pts[i - 1];
      const [bx, by] = this.pts[i];
      this.cum.push(this.cum[i - 1] + Math.hypot(bx - ax, by - ay));
    }
    this.lengthMi = this.cum[this.cum.length - 1];
  }

  private toMi(lng: number, lat: number): Pt {
    return [lng * this.miPerDegLng, lat * MI_PER_DEG_LAT];
  }

  private bounds(pts: Pt[]): [number, number, number, number] {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const [x, y] of pts) {
      if (x < minx) minx = x;
      if (y < miny) miny = y;
      if (x > maxx) maxx = x;
      if (y > maxy) maxy = y;
    }
    return [minx, miny, maxx, maxy];
  }

  private boundsToBbox(
    b: [number, number, number, number], radiusMi: number
  ): [number, number, number, number] {
    const [minx, miny, maxx, maxy] = b;
    const dlng = radiusMi / this.miPerDegLng;
    const dlat = radiusMi / MI_PER_DEG_LAT;
    return [
      minx / this.miPerDegLng - dlng,
      miny / MI_PER_DEG_LAT - dlat,
      maxx / this.miPerDegLng + dlng,
      maxy / MI_PER_DEG_LAT + dlat,
    ];
  }

  // (min_lng, min_lat, max_lng, max_lat) of route padded by radius.
  bbox(radiusMi: number): [number, number, number, number] {
    return this.boundsToBbox(this.bounds(this.pts), radiusMi);
  }

  // Bounding boxes that tile the route in chunks — used to keep live source
  // queries (Overpass) close to the corridor instead of one huge box around
  // a diagonal route.
  segmentBboxes(radiusMi: number, segLenMi = 60.0): [number, number, number, number][] {
    const boxes: [number, number, number, number][] = [];
    const n = Math.max(1, Math.ceil(this.lengthMi / segLenMi));
    for (let i = 0; i < n; i++) {
      const part = this.substring(i / n, (i + 1) / n);
      boxes.push(this.boundsToBbox(this.bounds(part), radiusMi));
    }
    return boxes;
  }

  // Point at `d` miles along the polyline.
  private interpolate(d: number): Pt {
    if (d <= 0) return this.pts[0];
    if (d >= this.lengthMi) return this.pts[this.pts.length - 1];
    // Binary search the cumulative-length array.
    let lo = 0, hi = this.cum.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= d) lo = mid; else hi = mid;
    }
    const segLen = this.cum[hi] - this.cum[lo];
    const t = segLen > 0 ? (d - this.cum[lo]) / segLen : 0;
    const [ax, ay] = this.pts[lo];
    const [bx, by] = this.pts[hi];
    return [ax + t * (bx - ax), ay + t * (by - ay)];
  }

  // Portion of the line between two fractional positions along its length.
  private substring(startFrac: number, endFrac: number): Pt[] {
    const n = 24;
    const pts: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      pts.push(this.interpolate(this.lengthMi * (startFrac + ((endFrac - startFrac) * i) / n)));
    }
    return pts;
  }

  // (lng, lat) points spaced along the route — used for Wikipedia geosearch,
  // whose radius is capped at 10 km per call.
  samplePoints(everyMi: number): [number, number][] {
    const out: [number, number][] = [];
    for (let d = 0; d <= this.lengthMi; d += everyMi) {
      const [x, y] = this.interpolate(d);
      out.push([x / this.miPerDegLng, y / MI_PER_DEG_LAT]);
    }
    return out;
  }

  // (straight-line miles from route, miles along route of nearest point).
  offsetAndAlong(lng: number, lat: number): [number, number] {
    const [px, py] = this.toMi(lng, lat);
    let best = Infinity;
    let bestAlong = 0;
    for (let i = 1; i < this.pts.length; i++) {
      const [ax, ay] = this.pts[i - 1];
      const [bx, by] = this.pts[i];
      // Cheap reject: segment's axis-aligned box vs. current best.
      const rx = px < Math.min(ax, bx) ? Math.min(ax, bx) - px : px > Math.max(ax, bx) ? px - Math.max(ax, bx) : 0;
      const ry = py < Math.min(ay, by) ? Math.min(ay, by) - py : py > Math.max(ay, by) ? py - Math.max(ay, by) : 0;
      if (rx > best || ry > best) continue;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d < best) {
        best = d;
        bestAlong = this.cum[i - 1] + t * Math.sqrt(len2);
      }
    }
    return [best, bestAlong];
  }

  // Approximate (added miles, added minutes) for an out-and-back from the
  // route: double the straight-line offset, scaled by a road circuity
  // factor, at an average detour speed.
  static detour(offsetMi: number): [number, number] {
    const mi = 2.0 * offsetMi * ROAD_CIRCUITY;
    const minutes = (mi / DETOUR_AVG_MPH) * 60.0;
    return [Math.round(mi * 10) / 10, Math.round(minutes)];
  }
}

// Spec §5 step 6: segment the route, keep only the top-ranking few per
// segment so results spread along the trip instead of clumping. `places`
// must already carry along_mi and rank. Returns sorted by rank desc.
export function decluster(places: Place[], routeLenMi: number, target = RESULT_TARGET): Place[] {
  if (!places.length) return [];
  const segLen = Math.max(8.0, routeLenMi / 25.0);
  const nBuckets = Math.max(1, Math.ceil(routeLenMi / segLen));
  const perBucket = Math.max(2, Math.ceil((target * 1.15) / nBuckets));

  const key = (p: Place) => (p.rank ?? p.score);

  const buckets = new Map<number, Place[]>();
  for (const p of places) {
    const b = Math.min(Math.floor((p.along_mi ?? 0) / segLen), nBuckets - 1);
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b)!.push(p);
  }

  const kept: Place[] = [];
  for (const members of buckets.values()) {
    members.sort((a, b) => key(b) - key(a));
    kept.push(...members.slice(0, perBucket));
  }

  kept.sort((a, b) => key(b) - key(a));
  return kept.slice(0, Math.floor(target * 1.1));
}
