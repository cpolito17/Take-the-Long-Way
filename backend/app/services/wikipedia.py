"""Wikipedia Geosearch — live per query (spec §4): articles with marked
coordinates near the route, with pageviews as the popularity signal.

Geosearch radius is capped at 10 km, so we sample points along the route
and run one generator=geosearch query per point, pulling description,
pageviews, thumbnail and coordinates in the same call. Plain
settlement/admin articles are filtered out — they're the opposite of the
deep cuts this app exists for."""

import asyncio
import logging
import re

import httpx

from .. import config, scoring
from ..categories import categorize
from ..models import Place

log = logging.getLogger(__name__)

# Article descriptions that mark "ordinary place" pages, not quirky stops:
# settlements/admin areas, schools, transport infrastructure, and the
# office-building / corporate noise Wikipedia geosearch is full of.
BORING_RE = re.compile(
    r"(city|town|village|borough|township|hamlet|census[- ]designated|"
    r"unincorporated community|county in|neighborhood|suburb|"
    r"school district|public school|high school|elementary school|"
    r"middle school|university|college|"
    r"interstate|u\.s\.? (route|highway)|state (route|highway)|freeway|"
    r"expressway|toll road|"
    r"airport|railway station|train station|transit|bus station|"
    r"shopping (mall|center|centre)|supermarket|radio station|"
    r"television station|sports venue|stadium|arena|"
    r"area code|telephone|zip code|postal code|"
    r"office building|office tower|office complex|office park|"
    r"headquarters|skyscraper|high-rise|corporate|"
    r"company|corporation|business(es)? |conglomerate|subsidiary|"
    r"hospital|medical center|clinic|nursing home|"
    r"hotel|motel chain|apartment|residential|condominium|housing|"
    r"golf course|country club|"
    r"power (plant|station)|substation|water treatment|sewage|landfill|"
    r"industrial park|distribution center|warehouse|"
    r"city hall|courthouse annex|government building|administrative|"
    r"post office|think tank|advocacy group|nonprofit|non-profit|"
    r"organization|federally recognized|tribe|"
    r"human settlement|populated place|settlement in|"
    r"^place in )",  # bare "Place in California, United States" descriptions
    re.IGNORECASE,
)

# Meta-articles that carry coordinates but aren't places at all.
BORING_TITLE_RE = re.compile(
    r"^(area codes? |list of |lists of |demographics of |timeline of |"
    r"index of |history of |geography of |climate of |economy of )",
    re.IGNORECASE,
)

MAX_POINTS = 30  # keeps very long routes to a sane number of API calls


async def _geosearch_at(
    client: httpx.AsyncClient, lng: float, lat: float, sem: asyncio.Semaphore
) -> list[dict]:
    params = {
        "action": "query",
        "format": "json",
        "generator": "geosearch",
        "ggscoord": f"{lat}|{lng}",
        "ggsradius": 10000,
        "ggslimit": 40,
        "prop": "description|pageviews|pageimages|coordinates",
        "piprop": "thumbnail",
        "pithumbsize": 480,
        "colimit": "max",
    }
    async with sem:
        try:
            r = await client.get(config.WIKIPEDIA_API_URL, params=params)
            r.raise_for_status()
            return list(r.json().get("query", {}).get("pages", {}).values())
        except Exception as e:
            log.warning("Wikipedia geosearch failed at %.3f,%.3f: %s", lat, lng, e)
            return []


def _page_to_place(page: dict) -> Place | None:
    coords = (page.get("coordinates") or [{}])[0]
    lat, lng = coords.get("lat"), coords.get("lon")
    if lat is None or lng is None:
        return None
    title = page["title"]
    desc = page.get("description", "") or ""
    if not desc or BORING_RE.search(desc) or BORING_TITLE_RE.search(title):
        return None
    views = sum(v or 0 for v in (page.get("pageviews") or {}).values())
    thumb = (page.get("thumbnail") or {}).get("source")
    score = scoring.universal_boosts(
        scoring.wikipedia(views), has_image=bool(thumb), description=desc
    )
    return Place(
        id=f"wp:{page['pageid']}",
        name=title,
        description=desc[0].upper() + desc[1:] if desc else "",
        category=categorize([], title, desc),
        source="wikipedia",
        source_url=f"https://en.wikipedia.org/?curid={page['pageid']}",
        lat=lat,
        lng=lng,
        image_url=thumb,
        score=score,
        tags=[],
    )


async def fetch(sample_points: list[tuple[float, float]]) -> list[Place]:
    if len(sample_points) > MAX_POINTS:
        step = len(sample_points) / MAX_POINTS
        sample_points = [sample_points[int(i * step)] for i in range(MAX_POINTS)]
    sem = asyncio.Semaphore(6)
    async with httpx.AsyncClient(
        timeout=30, headers={"User-Agent": config.USER_AGENT}
    ) as client:
        results = await asyncio.gather(
            *(_geosearch_at(client, lng, lat, sem) for (lng, lat) in sample_points)
        )
    places: dict[str, Place] = {}
    for pages in results:
        for page in pages:
            p = _page_to_place(page)
            if p and p.id not in places:
                places[p.id] = p
    return list(places.values())
