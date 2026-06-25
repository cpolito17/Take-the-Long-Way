"""OpenRouteService directions client (spec §3: routing is ORS, free tier,
key via environment). Returns the route as GeoJSON coordinates plus
distance/duration."""

import httpx
from fastapi import HTTPException

from .. import config
from ..models import RouteInfo

M_PER_MI = 1609.344


async def route(coordinates: list[list[float]]) -> RouteInfo:
    """coordinates: [[lng, lat], ...] origin → (stops) → destination."""
    if not config.ORS_API_KEY:
        raise HTTPException(500, "ORS_API_KEY is not configured")
    url = f"{config.ORS_BASE_URL}/v2/directions/driving-car/geojson"
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.post(
            url,
            json={"coordinates": coordinates},
            headers={
                "Authorization": config.ORS_API_KEY,
                "User-Agent": config.USER_AGENT,
            },
        )
    if r.status_code != 200:
        detail = "Routing failed"
        try:
            detail = r.json().get("error", {}).get("message", detail)
        except Exception:
            pass
        raise HTTPException(502, f"OpenRouteService error ({r.status_code}): {detail}")
    feature = r.json()["features"][0]
    summary = feature["properties"]["summary"]
    return RouteInfo(
        coordinates=feature["geometry"]["coordinates"],
        distance_mi=round(summary["distance"] / M_PER_MI, 1),
        duration_min=round(summary["duration"] / 60.0, 1),
    )
