"""Roadside America — best thematic fit for roadside oddities (spec §4).

There is currently NO public community dataset for Roadside America (it is
a commercial site and its data is only sold via its apps). This loader is a
drop-in slot: obtain a dataset, place it at data/raw/roadside_america.csv
(or .json), re-run the pipeline, and it flows through normalization,
scoring and de-dup like every other source. Until then the pipeline logs a
notice and skips it; the UI toggle simply yields no results.

Expected CSV columns (header row): name, lat, lng, description, url, image
Expected JSON: a list of objects with those same keys.
"""

import csv
import json
import logging

from ... import config, scoring
from ...categories import categorize
from ...models import Place
from .. import in_us

log = logging.getLogger(__name__)

CSV_FILE = config.RAW_DIR / "roadside_america.csv"
JSON_FILE = config.RAW_DIR / "roadside_america.json"


def _rows() -> list[dict]:
    if CSV_FILE.exists():
        with open(CSV_FILE, encoding="utf-8", errors="replace", newline="") as f:
            return list(csv.DictReader(f))
    if JSON_FILE.exists():
        with open(JSON_FILE, encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
    log.info(
        "Roadside America: no dataset at %s — skipping (drop a file in and re-run).",
        CSV_FILE,
    )
    return []


def load() -> list[Place]:
    places: list[Place] = []
    for i, row in enumerate(_rows()):
        try:
            lat, lng = float(row["lat"]), float(row["lng"])
        except (KeyError, TypeError, ValueError):
            continue
        if not in_us(lat, lng):
            continue
        name = (row.get("name") or "").strip()
        if not name:
            continue
        desc = (row.get("description") or "").strip()
        image = (row.get("image") or "").strip() or None
        # Curated roadside-oddity source: high baseline, like Atlas Obscura
        # entries without count signals.
        score = scoring.universal_boosts(55.0, has_image=bool(image), description=desc)
        places.append(
            Place(
                id=f"ra:{i}",
                name=name,
                description=desc,
                category=categorize(["roadside"], name, desc),
                source="roadside_america",
                source_url=(row.get("url") or "").strip(),
                lat=lat,
                lng=lng,
                image_url=image,
                score=score,
                tags=["roadside"],
            )
        )
    return places
