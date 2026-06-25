"""OpenStreetMap via Overpass — live per query (spec §4). We ask for a
curated slice of community-tagged oddities (tourism/historic tags) inside
bboxes tiled along the route corridor, never one huge box."""

import logging

import httpx

from .. import config, scoring
from ..categories import categorize
from ..models import Place

log = logging.getLogger(__name__)

# Tag values that match the "quirky deep cuts" brief; deliberately excludes
# generic tourism (hotels, viewpoints, info boards) and ubiquitous
# historic=memorial.
NODE_FILTERS = [
    '["tourism"~"^(attraction|artwork)$"]["name"]',
    '["historic"~"^(ruins|fort|wreck|ship|aircraft|locomotive|mine|battlefield|archaeological_site)$"]["name"]',
]


def _build_query(bboxes: list[tuple[float, float, float, float]]) -> str:
    parts = []
    for (min_lng, min_lat, max_lng, max_lat) in bboxes:
        bbox = f"({min_lat:.4f},{min_lng:.4f},{max_lat:.4f},{max_lng:.4f})"
        for flt in NODE_FILTERS:
            parts.append(f"node{flt}{bbox};")
            parts.append(f"way{flt}{bbox};")
    body = "\n".join(parts)
    return f"[out:json][timeout:50];\n(\n{body}\n);\nout center tags 900;"


def _element_to_place(el: dict) -> Place | None:
    tags = el.get("tags", {})
    name = tags.get("name")
    if not name:
        return None
    if el["type"] == "node":
        lat, lng = el.get("lat"), el.get("lon")
    else:
        center = el.get("center") or {}
        lat, lng = center.get("lat"), center.get("lon")
    if lat is None or lng is None:
        return None
    has_wiki = "wikipedia" in tags or "wikidata" in tags
    desc = tags.get("description", "") or tags.get("inscription", "")[:200]
    image = tags.get("image") if (tags.get("image", "").startswith("http")) else None
    tag_list = [
        f"{k}={v}" for k, v in tags.items()
        if k in ("tourism", "historic", "artwork_type", "ruins", "man_made")
    ]
    score = scoring.universal_boosts(
        scoring.osm(len(tags), has_wiki), has_image=bool(image), description=desc
    )
    url = (
        f"https://en.wikipedia.org/wiki/{tags['wikipedia'].split(':', 1)[-1]}"
        if tags.get("wikipedia") and ":" in tags.get("wikipedia", "")
        else f"https://www.openstreetmap.org/{el['type']}/{el['id']}"
    )
    return Place(
        id=f"osm:{el['type']}/{el['id']}",
        name=name,
        description=desc,
        category=categorize(tag_list, name, desc),
        source="osm",
        source_url=url,
        lat=lat,
        lng=lng,
        image_url=image,
        score=score,
        tags=tag_list,
    )


async def fetch(bboxes: list[tuple[float, float, float, float]]) -> list[Place]:
    query = _build_query(bboxes)
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            r = await client.post(
                config.OVERPASS_URL,
                data={"data": query},
                headers={"User-Agent": config.USER_AGENT},
            )
            r.raise_for_status()
            elements = r.json().get("elements", [])
    except Exception as e:
        log.warning("Overpass query failed (continuing without OSM): %s", e)
        return []
    places = []
    seen = set()
    for el in elements:
        p = _element_to_place(el)
        if p and p.id not in seen:
            seen.add(p.id)
            places.append(p)
    return places
