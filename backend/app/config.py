"""Central configuration. Everything comes from environment variables with
sane defaults so the same code runs natively (dev) and in the container."""

import os
from pathlib import Path

ORS_API_KEY = os.environ.get("ORS_API_KEY", "")
ORS_BASE_URL = os.environ.get("ORS_BASE_URL", "https://api.openrouteservice.org")
NOMINATIM_URL = os.environ.get("NOMINATIM_URL", "https://nominatim.openstreetmap.org")
OVERPASS_URL = os.environ.get("OVERPASS_URL", "https://overpass-api.de/api/interpreter")
WIKIPEDIA_API_URL = os.environ.get("WIKIPEDIA_API_URL", "https://en.wikipedia.org/w/api.php")
WIKIDATA_SPARQL_URL = os.environ.get("WIKIDATA_SPARQL_URL", "https://query.wikidata.org/sparql")

# Identify ourselves politely to the public endpoints we use. Wikimedia's
# robot policy (w.wiki/4wJS) rejects requests whose User-Agent lacks contact
# info, so include one — set TTLW_CONTACT to your email.
_CONTACT = os.environ.get("TTLW_CONTACT", "set-TTLW_CONTACT-env-var")
USER_AGENT = os.environ.get(
    "TTLW_USER_AGENT",
    f"TakeTheLongWayBot/1.0 (self-hosted road-trip planner; contact: {_CONTACT}) httpx",
)

DATA_DIR = Path(os.environ.get("DATA_DIR", Path(__file__).resolve().parents[2] / "data"))
RAW_DIR = DATA_DIR / "raw"
DB_PATH = DATA_DIR / "places.db"

FRONTEND_DIR = Path(
    os.environ.get("FRONTEND_DIR", Path(__file__).resolve().parents[2] / "frontend")
)

# Soft result target (spec §3: feel-based, not a hard cap).
RESULT_TARGET = 100

# Cheap detour approximation knobs (spec §5 step 4 allows approximation):
# detour distance = 2 * straight-line offset * road circuity factor.
ROAD_CIRCUITY = 1.35
DETOUR_AVG_MPH = 35.0

CACHED_SOURCES = {"atlas_obscura", "roadside_america", "wikidata", "hmdb"}
LIVE_SOURCES = {"osm", "wikipedia"}
ALL_SOURCES = CACHED_SOURCES | LIVE_SOURCES
