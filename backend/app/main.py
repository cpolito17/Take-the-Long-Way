"""Take the Long Way — FastAPI app. Serves the JSON API and the static
frontend from one process/container."""

import logging

from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles

from . import config, gmaps, store
from .geo import RouteCorridor
from .models import FinalizeRequest, FinalizeResponse, SearchRequest, SearchResponse, TripStats
from .search import run_search
from .services import nominatim, ors

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("ttlw")

app = FastAPI(title="Take the Long Way", version="1.0")


@app.on_event("startup")
async def startup() -> None:
    counts = store.stats(config.DB_PATH)
    if counts:
        log.info("Place cache loaded: %s", counts)
    else:
        log.warning(
            "No place cache at %s — run `python -m app.pipeline` (or "
            "`docker compose run --rm app python -m app.pipeline`). "
            "Live sources (OSM, Wikipedia) will still work.",
            config.DB_PATH,
        )
    if not config.ORS_API_KEY:
        log.warning("ORS_API_KEY is not set — routing requests will fail.")


@app.get("/api/health")
async def health() -> dict:
    return {
        "status": "ok",
        "cache": store.stats(config.DB_PATH),
        "ors_key_configured": bool(config.ORS_API_KEY),
    }


@app.get("/api/geocode")
async def geocode(q: str = Query(min_length=2)) -> list[dict]:
    return await nominatim.search(q)


@app.post("/api/search")
async def search(req: SearchRequest) -> SearchResponse:
    return await run_search(req)


@app.post("/api/finalize")
async def finalize(req: FinalizeRequest) -> FinalizeResponse:
    """Trip stats + Google Maps links: baseline route (user waypoints only)
    vs. the route with all selected stops inserted in along-route order."""
    base_coords = [[w.lng, w.lat] for w in req.waypoints]
    baseline = await ors.route(base_coords)
    corridor = RouteCorridor(baseline.coordinates)

    # Order every intermediate point (user stops + selected places) by its
    # position along the baseline route.
    def along(lng: float, lat: float) -> float:
        return corridor.offset_and_along(lng, lat)[1]

    ordered_stops = sorted(req.stops, key=lambda s: along(s.lng, s.lat))
    middles = [(w.lng, w.lat, "wp", w) for w in req.waypoints[1:-1]] + [
        (s.lng, s.lat, "stop", s) for s in ordered_stops
    ]
    middles.sort(key=lambda m: along(m[0], m[1]))

    full_coords = (
        [base_coords[0]] + [[m[0], m[1]] for m in middles] + [base_coords[-1]]
    )
    if len(full_coords) > 50:
        raise HTTPException(400, "Too many stops for a single trip (limit ~45).")
    trip_route = await ors.route(full_coords)

    points = [(lat, lng) for lng, lat in full_coords]
    return FinalizeResponse(
        route=trip_route,
        ordered_stops=ordered_stops,
        baseline=TripStats(distance_mi=baseline.distance_mi, duration_min=baseline.duration_min),
        trip=TripStats(distance_mi=trip_route.distance_mi, duration_min=trip_route.duration_min),
        added_mi=round(trip_route.distance_mi - baseline.distance_mi, 1),
        added_min=round(trip_route.duration_min - baseline.duration_min, 1),
        maps_links=gmaps.build_links(points),
    )


# Static frontend — mounted last so /api/* wins.
app.mount("/", StaticFiles(directory=config.FRONTEND_DIR, html=True), name="frontend")
