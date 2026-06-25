"""Google Maps handoff (spec §7): directions links with the selected places
as waypoints, in route order. One link if it fits; otherwise batched leg
links where each leg starts where the previous one ended."""

from urllib.parse import urlencode

from .models import MapsLink

# Google Maps directions links support ~10 points; origin + destination +
# up to 8 waypoints keeps a safe margin.
MAX_POINTS_PER_LINK = 10


def _fmt(lat: float, lng: float) -> str:
    return f"{lat:.6f},{lng:.6f}"


def _link(points: list[tuple[float, float]]) -> str:
    params = {
        "api": 1,
        "travelmode": "driving",
        "origin": _fmt(*points[0]),
        "destination": _fmt(*points[-1]),
    }
    middle = points[1:-1]
    if middle:
        params["waypoints"] = "|".join(_fmt(lat, lng) for lat, lng in middle)
    return "https://www.google.com/maps/dir/?" + urlencode(params)


def build_links(points: list[tuple[float, float]]) -> list[MapsLink]:
    """points: full ordered stop list (lat, lng) — origin, stops..., destination."""
    if len(points) <= MAX_POINTS_PER_LINK:
        return [MapsLink(label="Open in Google Maps", url=_link(points))]
    links = []
    start = 0
    leg = 1
    while start < len(points) - 1:
        end = min(start + MAX_POINTS_PER_LINK - 1, len(points) - 1)
        links.append(
            MapsLink(label=f"Open Leg {leg} in Google Maps", url=_link(points[start:end + 1]))
        )
        start = end  # next leg starts where this one ended
        leg += 1
    return links
