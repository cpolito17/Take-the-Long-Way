"""Nominatim geocoding proxy (spec §3). Proxied through the backend so the
browser never hits the public endpoint directly (consistent User-Agent,
no CORS issues). The frontend debounces; we keep requests minimal."""

import httpx

from .. import config


async def search(q: str, limit: int = 5) -> list[dict]:
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            f"{config.NOMINATIM_URL}/search",
            params={
                "q": q,
                "format": "jsonv2",
                "countrycodes": "us",
                "limit": limit,
                "addressdetails": 0,
            },
            headers={"User-Agent": config.USER_AGENT},
        )
        r.raise_for_status()
    return [
        {
            "name": item.get("display_name", ""),
            "lat": float(item["lat"]),
            "lng": float(item["lon"]),
        }
        for item in r.json()
    ]
