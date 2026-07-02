// Google Maps handoff (spec §7). Mirrors backend/app/gmaps.py: directions
// links with the selected places as waypoints, in route order. One link if
// it fits; otherwise batched leg links where each leg starts where the
// previous one ended.

import type { MapsLink } from "./types";

// Google Maps directions links support ~10 points; origin + destination +
// up to 8 waypoints keeps a safe margin.
const MAX_POINTS_PER_LINK = 10;

function fmt(lat: number, lng: number): string {
  return `${lat.toFixed(6)},${lng.toFixed(6)}`;
}

function link(points: [number, number][]): string {
  const params = new URLSearchParams({
    api: "1",
    travelmode: "driving",
    origin: fmt(...points[0]),
    destination: fmt(...points[points.length - 1]),
  });
  const middle = points.slice(1, -1);
  if (middle.length) {
    params.set("waypoints", middle.map(([lat, lng]) => fmt(lat, lng)).join("|"));
  }
  return "https://www.google.com/maps/dir/?" + params.toString();
}

// points: full ordered stop list (lat, lng) — origin, stops..., destination.
export function buildLinks(points: [number, number][]): MapsLink[] {
  if (points.length <= MAX_POINTS_PER_LINK) {
    return [{ label: "Open in Google Maps", url: link(points) }];
  }
  const links: MapsLink[] = [];
  let start = 0;
  let leg = 1;
  while (start < points.length - 1) {
    const end = Math.min(start + MAX_POINTS_PER_LINK - 1, points.length - 1);
    links.push({ label: `Open Leg ${leg} in Google Maps`, url: link(points.slice(start, end + 1)) });
    start = end; // next leg starts where this one ended
    leg += 1;
  }
  return links;
}
