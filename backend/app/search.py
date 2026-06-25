"""The per-search filtering pipeline (spec §5):
route → bbox candidates (cache + live) → corridor filter → detour →
keyword/source filter → de-dup → de-cluster → sorted, soft-capped."""

import asyncio
import logging

from . import config, store
from .dedupe import dedupe
from .geo import RouteCorridor, decluster
from .models import Place, SearchRequest, SearchResponse
from .services import ors, overpass, wikipedia

log = logging.getLogger(__name__)

# Default-ranking confidence per source: how much we trust the score as a
# "people actually love this place" signal. Atlas Obscura's want-to-go /
# been-here counts are real traveler interest; HMDb's flat curated baseline
# is not, so it fills in rather than leads.
SOURCE_CONFIDENCE = {
    "atlas_obscura": 1.0,
    "roadside_america": 0.95,
    "wikipedia": 0.85,
    "wikidata": 0.80,
    "osm": 0.72,
    "hmdb": 0.58,
}

# Max rank penalty for sitting at the far edge of the corridor — favors
# closer-to-route results without hard-excluding the edge.
PROXIMITY_PENALTY = 14.0


def _rank(p: Place, radius_mi: float) -> float:
    conf = max(SOURCE_CONFIDENCE.get(s, 0.7) for s in (p.sources or [p.source]))
    proximity = PROXIMITY_PENALTY * ((p.offset_mi or 0.0) / radius_mi)
    return round(p.score * conf - proximity, 1)


def _keyword_match(p: Place, keyword: str) -> bool:
    kw = keyword.strip().lower()
    if not kw:
        return True
    hay = " ".join([p.name, p.description, " ".join(p.tags), p.category]).lower()
    return all(token in hay for token in kw.split())


async def run_search(req: SearchRequest) -> SearchResponse:
    enabled = set(req.sources) & config.ALL_SOURCES if req.sources else set(config.ALL_SOURCES)

    # 1. Route from ORS.
    route = await ors.route([[w.lng, w.lat] for w in req.waypoints])
    corridor = RouteCorridor(route.coordinates)

    # 2. Gather candidates: local cache + live sources, in parallel.
    tasks = []
    if "osm" in enabled:
        tasks.append(overpass.fetch(corridor.segment_bboxes(req.radius_mi)))
    if "wikipedia" in enabled:
        # Sample spacing ~ the geosearch radius (10 km ≈ 6.2 mi) so coverage
        # is continuous along the line.
        tasks.append(wikipedia.fetch(corridor.sample_points(every_mi=11.0)))

    cached_enabled = enabled & config.CACHED_SOURCES
    candidates: list[Place] = []
    if cached_enabled:
        candidates.extend(
            store.query_bbox(config.DB_PATH, corridor.bbox(req.radius_mi), cached_enabled)
        )
    if tasks:
        for result in await asyncio.gather(*tasks):
            candidates.extend(result)

    # 3. Corridor filter + position along route.
    in_corridor: list[Place] = []
    for p in candidates:
        offset, along = corridor.offset_and_along(p.lng, p.lat)
        if offset <= req.radius_mi:
            p.offset_mi = round(offset, 1)
            p.along_mi = round(along, 1)
            # 4. Cheap detour approximation (spec allows).
            p.detour_mi, p.detour_min = corridor.detour(offset)
            in_corridor.append(p)

    # 5. Keyword filter (sources already filtered at gather time).
    filtered = [p for p in in_corridor if _keyword_match(p, req.keyword)]

    # De-dup live results against cached ones (same physical place from
    # e.g. Wikipedia + Atlas Obscura), then rank: popularity-confidence-
    # weighted score, minus a penalty the farther off-route a place sits.
    merged = dedupe(filtered)
    for p in merged:
        p.rank = _rank(p, req.radius_mi)

    # 6–7. de-cluster and cap (by rank).
    final = decluster(merged, corridor.length_mi)

    log.info(
        "search: %d candidates → %d in corridor → %d after filters → %d returned",
        len(candidates), len(in_corridor), len(merged), len(final),
    )
    return SearchResponse(route=route, places=final, total_candidates=len(merged))
