"""Atlas Obscura — the flagship source (spec §4).

Dataset: community-scraped TSV from the Sapienza ADM-HW3 scrape
(github.com/TitoTamburini/AtlasObscura-WebScraping, late-2022 snapshot of
Atlas Obscura's "most popular places", ~7k places worldwide). Columns
include name, tags, been-here/want-to-go counts, descriptions, lat/lng and
the source URL — the counts are the dominant scoring signal per spec §5.

Drop-in replacement: point ATLAS_OBSCURA_TSV_URL at a different file (or
place one at data/raw/atlas_obscura_merged.tsv) with the same columns and
re-run the pipeline. Nothing else changes.
"""

import ast
import csv
import logging
import os
import sys

import httpx

from ... import config, scoring
from ...categories import categorize
from ...models import Place
from .. import in_us

log = logging.getLogger(__name__)

DEFAULT_URL = (
    "https://raw.githubusercontent.com/TitoTamburini/AtlasObscura-WebScraping/main/merged.tsv"
)
RAW_FILE = config.RAW_DIR / "atlas_obscura_merged.tsv"

csv.field_size_limit(min(sys.maxsize, 2**31 - 1))


def _ensure_file() -> None:
    if RAW_FILE.exists():
        return
    url = os.environ.get("ATLAS_OBSCURA_TSV_URL", DEFAULT_URL)
    log.info("Downloading Atlas Obscura dataset from %s", url)
    RAW_FILE.parent.mkdir(parents=True, exist_ok=True)
    with httpx.stream("GET", url, follow_redirects=True, timeout=120) as r:
        r.raise_for_status()
        with open(RAW_FILE, "wb") as f:
            for chunk in r.iter_bytes():
                f.write(chunk)


def _parse_tags(raw: str) -> list[str]:
    # Tags arrive as a Python list literal, e.g. "['subways', 'abandoned']".
    try:
        val = ast.literal_eval(raw.strip())
        if isinstance(val, list):
            return [str(t).strip() for t in val if str(t).strip()]
    except (ValueError, SyntaxError):
        pass
    return []


def _int(raw: str) -> int:
    try:
        return int(float(raw.strip()))
    except (ValueError, AttributeError):
        return 0


def load() -> list[Place]:
    _ensure_file()
    places: list[Place] = []
    with open(RAW_FILE, encoding="utf-8", errors="replace", newline="") as f:
        reader = csv.DictReader(f, delimiter="\t")
        # Headers (and values) in this dataset carry stray whitespace.
        reader.fieldnames = [h.strip() for h in (reader.fieldnames or [])]
        for row in reader:
            row = {k: (v or "").strip() for k, v in row.items() if k}
            try:
                lat = float(row.get("placeAlt", ""))
                lng = float(row.get("placeLong", ""))
            except ValueError:
                continue
            if not in_us(lat, lng):
                continue
            name = row.get("placeName", "")
            if not name:
                continue
            url = row.get("placeURL", "")
            slug = url.rstrip("/").rsplit("/", 1)[-1] if url else name.lower().replace(" ", "-")
            tags = _parse_tags(row.get("placeTags", ""))
            desc = row.get("placeShortDesc", "") or row.get("placeDesc", "")[:240]
            want = _int(row.get("placePeopleWant", ""))
            visited = _int(row.get("placePeopleVisited", ""))
            score = scoring.universal_boosts(
                scoring.atlas_obscura(want, visited), has_image=False, description=desc
            )
            places.append(
                Place(
                    id=f"ao:{slug}",
                    name=name,
                    description=desc,
                    category=categorize(tags, name, desc),
                    source="atlas_obscura",
                    source_url=url,
                    lat=lat,
                    lng=lng,
                    score=score,
                    tags=tags[:10],
                )
            )
    return places
