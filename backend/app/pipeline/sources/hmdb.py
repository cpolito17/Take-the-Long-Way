"""Historical Marker Database (HMDb) — 200k+ geolocated physical historical
markers (spec §4), cached locally.

Dataset: the TidyTuesday 2023-07-04 bulk CSV, which is an export of
HMDb.org's marker list (title, coordinates, erected-by, year, link). It has
no photo-count/verification columns, so HMDb scores a flat curated baseline
(spec §5 lists those only as optional boosters).

Drop-in replacement: set HMDB_CSV_URL or place a CSV with the same columns
at data/raw/hmdb_markers.csv and re-run the pipeline.
"""

import csv
import logging
import os

import httpx

from ... import config, scoring
from ...models import Place
from .. import in_us

log = logging.getLogger(__name__)

DEFAULT_URL = (
    "https://raw.githubusercontent.com/rfordatascience/tidytuesday/master/"
    "data/2023/2023-07-04/historical_markers.csv"
)
RAW_FILE = config.RAW_DIR / "hmdb_markers.csv"


def _ensure_file() -> None:
    if RAW_FILE.exists():
        return
    url = os.environ.get("HMDB_CSV_URL", DEFAULT_URL)
    log.info("Downloading HMDb dataset from %s", url)
    RAW_FILE.parent.mkdir(parents=True, exist_ok=True)
    with httpx.stream("GET", url, follow_redirects=True, timeout=120) as r:
        r.raise_for_status()
        with open(RAW_FILE, "wb") as f:
            for chunk in r.iter_bytes():
                f.write(chunk)


def load() -> list[Place]:
    _ensure_file()
    places: list[Place] = []
    with open(RAW_FILE, encoding="utf-8", errors="replace", newline="") as f:
        for row in csv.DictReader(f):
            if (row.get("missing") or "NA") != "NA":
                continue  # marker reported missing
            try:
                lat = float(row.get("latitude_minus_s", ""))
                lng = float(row.get("longitude_minus_w", ""))
            except ValueError:
                continue
            if not in_us(lat, lng):
                continue
            title = (row.get("title") or "").strip()
            if not title:
                continue
            marker_id = row.get("marker_id", "")
            subtitle = (row.get("subtitle") or "").strip()
            if subtitle == "NA":
                subtitle = ""
            city = (row.get("city_or_town") or "").strip()
            state = (row.get("state_or_prov") or "").strip()
            erected = (row.get("erected_by") or "").strip()
            desc_bits = [subtitle] if subtitle else []
            loc = ", ".join(x for x in (city, state) if x and x != "NA")
            if loc:
                desc_bits.append(f"Historical marker in {loc}.")
            if erected and erected != "NA":
                desc_bits.append(f"Erected by {erected}.")
            desc = " ".join(desc_bits)
            score = scoring.universal_boosts(scoring.hmdb(), has_image=False, description=desc)
            places.append(
                Place(
                    id=f"hmdb:{marker_id}",
                    name=title,
                    description=desc,
                    category="Historical",
                    source="hmdb",
                    source_url=(row.get("link") or "").strip(),
                    lat=lat,
                    lng=lng,
                    score=score,
                    tags=[t for t in (state, "historical marker") if t],
                )
            )
    return places
