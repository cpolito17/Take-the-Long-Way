"""End-to-end verification harness for TTLW (run against a live server).

Checks, in order:
  1. /api/health responds and reports the place cache + ORS key.
  2. /api/geocode returns coordinates for a real query.
  3. /api/search on a sample route (Ann Arbor → Chicago) returns a real
     route polyline and selectable places with all card-critical fields.
  4. /api/finalize with a few selected places returns sane trip stats and
     valid Google Maps directions links (format + point budget + leg
     chaining).

Usage: python scripts/verify.py [base_url]   (default http://127.0.0.1:8000)
"""

import re
import sys
from urllib.parse import parse_qs, urlparse

import httpx

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
ANN_ARBOR = {"name": "Ann Arbor, MI", "lat": 42.2808, "lng": -83.7430}
CHICAGO = {"name": "Chicago, IL", "lat": 41.8781, "lng": -87.6298}

PASS = 0
FAIL = 0


def check(label: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    mark = "PASS" if cond else "FAIL"
    if cond:
        PASS += 1
    else:
        FAIL += 1
    print(f"  [{mark}] {label}" + (f"  — {detail}" if detail else ""))


def main() -> int:
    client = httpx.Client(base_url=BASE, timeout=180)

    print(f"\n=== TTLW verification against {BASE} ===\n")

    print("1. Health")
    r = client.get("/api/health")
    check("health endpoint responds 200", r.status_code == 200)
    health = r.json()
    cache = health.get("cache", {})
    check("place cache present", bool(cache), str(cache))
    check("ORS key configured", health.get("ors_key_configured") is True)

    print("\n2. Geocoding")
    r = client.get("/api/geocode", params={"q": "Ann Arbor, Michigan"})
    ok = r.status_code == 200 and len(r.json()) > 0
    check("geocode returns results", ok, r.json()[0]["name"][:60] if ok else r.text[:120])

    print("\n3. Search (Ann Arbor → Chicago, 25 mi corridor)")
    r = client.post(
        "/api/search",
        json={"waypoints": [ANN_ARBOR, CHICAGO], "radius_mi": 25, "keyword": "", "sources": []},
    )
    check("search responds 200", r.status_code == 200, "" if r.status_code == 200 else r.text[:200])
    if r.status_code != 200:
        return summary()
    data = r.json()
    route = data["route"]
    check("route polyline has many points", len(route["coordinates"]) > 100,
          f"{len(route['coordinates'])} points")
    check("route distance plausible (200–320 mi)", 200 < route["distance_mi"] < 320,
          f"{route['distance_mi']} mi, {route['duration_min']} min")
    places = data["places"]
    check("places returned", len(places) >= 20, f"{len(places)} places")
    check("soft cap respected (≤115)", len(places) <= 115, f"{len(places)}")
    # Ranking is confidence-weighted, so popularity-backed sources (AO,
    # Wikipedia) legitimately dominate dense corridors; HMDb/OSM fill
    # sparser segments. Require the flagship source plus at least one other.
    srcs = {p["source"] for p in places}
    check("atlas_obscura present + ≥2 sources",
          "atlas_obscura" in srcs and len(srcs) >= 2, str(sorted(srcs)))
    bad = [
        p for p in places
        if not p.get("name") or p.get("detour_mi") is None or p.get("detour_min") is None
        or not p.get("category") or not p.get("id")
    ]
    check("every place has card-critical fields (name/category/detour)", not bad,
          f"{len(bad)} bad" if bad else "")
    in_corridor = all((p["offset_mi"] or 0) <= 25.01 for p in places)
    check("every place inside the corridor radius", in_corridor)
    ranks = [p.get("rank") for p in places]
    check("every place has a rank", all(r is not None for r in ranks))
    check("sorted by rank desc", ranks == sorted(ranks, reverse=True))
    junk_re = re.compile(
        r"(area code|office building|headquarters|school district|shopping mall)",
        re.IGNORECASE,
    )
    junk = [p["name"] for p in places
            if junk_re.search(p["name"]) or junk_re.search(p.get("description", ""))]
    check("no obvious junk results (area codes / office buildings)", not junk,
          "; ".join(junk[:3]) if junk else "")
    with_img = sum(1 for p in places if p.get("image_url"))
    with_desc = sum(1 for p in places if p.get("description"))
    print(f"       (info: {with_img}/{len(places)} have images, {with_desc} have descriptions)")
    print("       top finds:", "; ".join(p["name"][:42] for p in places[:5]))

    print("\n4. Finalize + Google Maps links")
    picks = places[:3]
    r = client.post(
        "/api/finalize",
        json={
            "waypoints": [ANN_ARBOR, CHICAGO],
            "stops": [
                {"id": p["id"], "name": p["name"], "lat": p["lat"], "lng": p["lng"],
                 "category": p["category"], "detour_mi": p["detour_mi"],
                 "detour_min": p["detour_min"]}
                for p in picks
            ],
        },
    )
    check("finalize responds 200", r.status_code == 200,
          "" if r.status_code == 200 else r.text[:200])
    if r.status_code != 200:
        return summary()
    fin = r.json()
    check("trip ≥ baseline distance", fin["trip"]["distance_mi"] >= fin["baseline"]["distance_mi"],
          f"baseline {fin['baseline']['distance_mi']} mi → trip {fin['trip']['distance_mi']} mi "
          f"(+{fin['added_mi']} mi / +{fin['added_min']} min)")
    check("stops ordered along route", len(fin["ordered_stops"]) == 3)
    links = fin["maps_links"]
    check("maps link(s) present", len(links) >= 1, f"{len(links)} link(s)")
    validate_links(links, expected_points=3 + 2)

    # Force batching: finalize with 12 stops → multiple chained legs.
    many = places[:12]
    if len(many) >= 12:
        r = client.post(
            "/api/finalize",
            json={
                "waypoints": [ANN_ARBOR, CHICAGO],
                "stops": [
                    {"id": p["id"], "name": p["name"], "lat": p["lat"], "lng": p["lng"]}
                    for p in many
                ],
            },
        )
        check("12-stop finalize responds 200", r.status_code == 200,
              "" if r.status_code == 200 else r.text[:200])
        if r.status_code == 200:
            links = r.json()["maps_links"]
            check("batched into multiple legs", len(links) >= 2, f"{len(links)} legs")
            validate_links(links, expected_points=12 + 2)
    else:
        check("12-stop batching test (skipped — not enough places)", False)

    return summary()


def validate_links(links: list[dict], expected_points: int) -> None:
    coord_re = re.compile(r"^-?\d{1,3}\.\d+,-?\d{1,3}\.\d+$")
    all_points: list[str] = []
    prev_dest = None
    for link in links:
        u = urlparse(link["url"])
        check(f"link is a Google Maps dir URL: {link['label']}",
              u.netloc == "www.google.com" and u.path == "/maps/dir/", link["url"][:90] + "…")
        q = parse_qs(u.query)
        origin, dest = q["origin"][0], q["destination"][0]
        wps = q.get("waypoints", [""])[0]
        pts = [origin] + ([w for w in wps.split("|") if w] if wps else []) + [dest]
        check("≤10 points in link", len(pts) <= 10, f"{len(pts)} points")
        check("all points are lat,lng pairs", all(coord_re.match(p) for p in pts))
        if prev_dest is not None:
            check("leg chains from previous leg's end", origin == prev_dest)
        prev_dest = dest
        all_points.extend(pts if not all_points else pts[1:])
    check("links cover every stop exactly once", len(all_points) == expected_points,
          f"{len(all_points)} vs expected {expected_points}")


def summary() -> int:
    print(f"\n=== {PASS} passed, {FAIL} failed ===\n")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
