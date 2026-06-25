"""Wikidata — geolocated cultural/historic/unusual items with structured
type tags (spec §4), cached locally by the pipeline.

We query a curated set of "quirky" classes by direct P31 (instance-of);
QIDs were verified against the live wbsearchentities API.

Endpoint: the QLever public Wikidata SPARQL endpoint by default. The
official WDQS endpoint enforces an aggressive ~1 req/min limit (and worse
during outages), which made pipeline runs flaky; QLever serves the same
data without it. Override with WIKIDATA_SPARQL_URL to use WDQS — the query
is plain SPARQL 1.1 (no SERVICE wikibase:label), so it runs on both.
"""

import logging
import os
import re
import time

import httpx

from ... import config, scoring
from ...categories import categorize
from ...models import Place
from .. import in_us

log = logging.getLogger(__name__)

SPARQL_URL = os.environ.get("WIKIDATA_SPARQL_URL", "https://qlever.dev/api/wikidata")

# label -> (QID, fallback category hint)
QUIRKY_CLASSES = {
    "ghost town": ("Q74047", "Ruins"),
    "roadside attraction": ("Q14915208", "Roadside"),
    "novelty architecture": ("Q548879", "Roadside"),
    "muffler man": ("Q6932025", "Roadside"),
    "land art": ("Q326478", "Art"),
    "colossal statue": ("Q1779653", "Art"),
    "ruins": ("Q109607", "Ruins"),
}

QUERY_TEMPLATE = """
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX schema: <http://schema.org/>
SELECT ?item ?label ?desc ?coord ?image ?article (COUNT(DISTINCT ?sl) AS ?sitelinks) WHERE {{
  ?item wdt:P31/wdt:P279* wd:{qid} ;
        wdt:P625 ?coord ;
        wdt:P17 wd:Q30 ;
        rdfs:label ?label .
  FILTER(LANG(?label) = "en")
  OPTIONAL {{ ?item schema:description ?desc . FILTER(LANG(?desc) = "en") }}
  OPTIONAL {{ ?item wdt:P18 ?image . }}
  OPTIONAL {{ ?sl schema:about ?item . }}
  OPTIONAL {{ ?article schema:about ?item .
              ?article schema:isPartOf <https://en.wikipedia.org/> . }}
}}
GROUP BY ?item ?label ?desc ?coord ?image ?article
LIMIT 10000
"""

# WDQS emits "Point(lng lat)", QLever normalizes to "POINT(lng lat)".
_POINT_RE = re.compile(r"POINT\(([-\d.eE+]+) ([-\d.eE+]+)\)", re.IGNORECASE)


def _query(client: httpx.Client, qid: str) -> list[dict]:
    for attempt in range(3):
        r = client.get(
            SPARQL_URL,
            params={"query": QUERY_TEMPLATE.format(qid=qid), "format": "json"},
        )
        if r.status_code == 429 and attempt < 2:
            wait = min(max(int(r.headers.get("Retry-After", 70)), 70), 80)
            log.info("Wikidata 429 for %s — retrying in %ds", qid, wait)
            time.sleep(wait)
            continue
        r.raise_for_status()
        return r.json()["results"]["bindings"]
    return []


def _commons_thumb(image_url: str) -> str:
    # Special:FilePath redirects to the original (often huge); ask for a
    # thumb, and force https (the SPARQL results use http URLs).
    if not image_url:
        return ""
    return image_url.replace("http://", "https://", 1) + "?width=480"


def _val(binding: dict, key: str) -> str:
    return binding.get(key, {}).get("value", "")


def load() -> list[Place]:
    places: dict[str, Place] = {}
    with httpx.Client(
        headers={"User-Agent": config.USER_AGENT, "Accept": "application/sparql-results+json"},
        timeout=120,
        follow_redirects=True,
    ) as client:
        for label, (qid, cat_hint) in QUIRKY_CLASSES.items():
            try:
                rows = _query(client, qid)
            except Exception as e:  # one class failing shouldn't sink the load
                log.warning("Wikidata class %r (%s) failed: %s", label, qid, e)
                continue
            n_before = len(places)
            for b in rows:
                m = _POINT_RE.search(_val(b, "coord"))
                if not m:
                    continue  # unknown-value coordinates come back as blank nodes
                lng, lat = float(m.group(1)), float(m.group(2))
                if not in_us(lat, lng):
                    continue
                item_qid = _val(b, "item").rsplit("/", 1)[-1]
                name = _val(b, "label")
                if not name:
                    continue
                pid = f"wd:{item_qid}"
                if pid in places:  # item matched multiple classes
                    if label not in places[pid].tags:
                        places[pid].tags.append(label)
                    continue
                desc = _val(b, "desc")
                image = _commons_thumb(_val(b, "image"))
                article = _val(b, "article")
                try:
                    sitelinks = int(_val(b, "sitelinks") or 0)
                except ValueError:
                    sitelinks = 0
                tags = [label]
                score = scoring.universal_boosts(
                    scoring.wikidata(sitelinks), has_image=bool(image), description=desc
                )
                cat = categorize(tags, name, desc)
                places[pid] = Place(
                    id=pid,
                    name=name,
                    description=desc,
                    category=cat if cat != "Other" else cat_hint,
                    source="wikidata",
                    source_url=article or f"https://www.wikidata.org/wiki/{item_qid}",
                    lat=lat,
                    lng=lng,
                    image_url=image or None,
                    score=score,
                    tags=tags,
                )
            log.info("Wikidata %-22s %5d US items", label, len(places) - n_before)
            time.sleep(1)  # be polite
    return list(places.values())
