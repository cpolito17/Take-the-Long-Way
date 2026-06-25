"""Route-corridor geometry: buffer filtering, detour approximation,
spatial de-clustering. All deliberately cheap approximations (spec §3, §5).

Internally we work in a local equirectangular projection measured in miles,
which is plenty accurate for corridor-width filtering at US scales.
"""

import math

from shapely.geometry import LineString, Point

from . import config

MI_PER_DEG_LAT = 69.0


class RouteCorridor:
    def __init__(self, coordinates: list[list[float]]):
        """coordinates: route polyline as [lng, lat] pairs."""
        lats = [c[1] for c in coordinates]
        self.ref_lat = sum(lats) / len(lats)
        self.mi_per_deg_lng = MI_PER_DEG_LAT * math.cos(math.radians(self.ref_lat))
        pts = [self._to_mi(c[0], c[1]) for c in coordinates]
        line = LineString(pts)
        # Simplify to keep per-candidate distance checks fast on long routes;
        # 0.5 mi tolerance is far below any usable corridor radius.
        self.line = line.simplify(0.5)
        self.length_mi = self.line.length

    def _to_mi(self, lng: float, lat: float) -> tuple[float, float]:
        return (lng * self.mi_per_deg_lng, lat * MI_PER_DEG_LAT)

    def bbox(self, radius_mi: float) -> tuple[float, float, float, float]:
        """(min_lng, min_lat, max_lng, max_lat) of route padded by radius."""
        minx, miny, maxx, maxy = self.line.bounds
        dlng = radius_mi / self.mi_per_deg_lng
        dlat = radius_mi / MI_PER_DEG_LAT
        return (
            minx / self.mi_per_deg_lng - dlng,
            miny / MI_PER_DEG_LAT - dlat,
            maxx / self.mi_per_deg_lng + dlng,
            maxy / MI_PER_DEG_LAT + dlat,
        )

    def segment_bboxes(
        self, radius_mi: float, seg_len_mi: float = 60.0
    ) -> list[tuple[float, float, float, float]]:
        """Bounding boxes that tile the route in chunks — used to keep live
        source queries (Overpass) close to the corridor instead of one huge
        box around a diagonal route."""
        boxes = []
        n = max(1, math.ceil(self.length_mi / seg_len_mi))
        for i in range(n):
            part = substring(self.line, i / n, (i + 1) / n)
            minx, miny, maxx, maxy = part.bounds
            dlng = radius_mi / self.mi_per_deg_lng
            dlat = radius_mi / MI_PER_DEG_LAT
            boxes.append(
                (
                    minx / self.mi_per_deg_lng - dlng,
                    miny / MI_PER_DEG_LAT - dlat,
                    maxx / self.mi_per_deg_lng + dlng,
                    maxy / MI_PER_DEG_LAT + dlat,
                )
            )
        return boxes

    def sample_points(self, every_mi: float) -> list[tuple[float, float]]:
        """(lng, lat) points spaced along the route — used for Wikipedia
        geosearch, whose radius is capped at 10 km per call."""
        pts = []
        d = 0.0
        while d <= self.length_mi:
            p = self.line.interpolate(d)
            pts.append((p.x / self.mi_per_deg_lng, p.y / MI_PER_DEG_LAT))
            d += every_mi
        return pts

    def offset_and_along(self, lng: float, lat: float) -> tuple[float, float]:
        """(straight-line miles from route, miles along route of nearest point)."""
        p = Point(self._to_mi(lng, lat))
        return (self.line.distance(p), self.line.project(p))

    @staticmethod
    def detour(offset_mi: float) -> tuple[float, float]:
        """Approximate (added miles, added minutes) for an out-and-back from
        the route: double the straight-line offset, scaled by a road
        circuity factor, at an average detour speed."""
        mi = 2.0 * offset_mi * config.ROAD_CIRCUITY
        minutes = mi / config.DETOUR_AVG_MPH * 60.0
        return (round(mi, 1), round(minutes))


def substring(line: LineString, start_frac: float, end_frac: float) -> LineString:
    """Portion of a line between two fractional positions along its length."""
    n = 24
    pts = [
        line.interpolate(line.length * (start_frac + (end_frac - start_frac) * i / n))
        for i in range(n + 1)
    ]
    return LineString(pts)


def decluster(places: list, route_len_mi: float, target: int = config.RESULT_TARGET) -> list:
    """Spec §5 step 6: segment the route, keep only the top-ranking few per
    segment so results spread along the trip instead of clumping. `places`
    must already carry along_mi and rank. Returns sorted by rank desc."""
    if not places:
        return []
    seg_len = max(8.0, route_len_mi / 25.0)
    n_buckets = max(1, math.ceil(route_len_mi / seg_len))
    per_bucket = max(2, math.ceil(target * 1.15 / n_buckets))

    def key(p):
        return p.rank if p.rank is not None else p.score

    buckets: dict[int, list] = {}
    for p in places:
        b = min(int((p.along_mi or 0) / seg_len), n_buckets - 1)
        buckets.setdefault(b, []).append(p)

    kept = []
    for members in buckets.values():
        members.sort(key=key, reverse=True)
        kept.extend(members[:per_bucket])

    kept.sort(key=key, reverse=True)
    return kept[: int(target * 1.1)]
