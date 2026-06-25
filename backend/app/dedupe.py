"""De-duplication across sources (spec §4): entries from different sources
that are the same physical place — close coordinates + similar names — are
merged, not shown twice. Used both by the pipeline (cached sources) and at
query time (live results vs. cached results)."""

import re
from difflib import SequenceMatcher

from .models import Place
from .scoring import cross_source_boost

GRID_DEG = 0.005  # ~0.35 mi of latitude per cell
NAME_SIM_THRESHOLD = 0.62

_STOPWORDS = re.compile(
    r"\b(the|of|and|a|an|at|in|on|historic|historical|site|marker|monument|museum)\b"
)
_NON_ALNUM = re.compile(r"[^a-z0-9 ]+")


def norm_name(name: str) -> str:
    s = _NON_ALNUM.sub(" ", name.lower())
    s = _STOPWORDS.sub(" ", s)
    return " ".join(s.split())


def _similar(a: str, b: str) -> bool:
    if not a or not b:
        return False
    if a == b or a in b or b in a:
        return True
    return SequenceMatcher(None, a, b).ratio() >= NAME_SIM_THRESHOLD


def _cell(p: Place) -> tuple[int, int]:
    return (int(p.lat / GRID_DEG), int(p.lng / GRID_DEG))


def merge_into(primary: Place, other: Place) -> Place:
    """Fold `other` into `primary` (assumed the higher-scoring of the two),
    filling gaps and recording the extra source."""
    if not primary.description and other.description:
        primary.description = other.description
    if not primary.image_url and other.image_url:
        primary.image_url = other.image_url
    if not primary.source_url and other.source_url:
        primary.source_url = other.source_url
    primary.tags = list(dict.fromkeys(primary.tags + other.tags))
    merged_sources = list(dict.fromkeys(primary.sources + other.sources))
    primary.sources = merged_sources
    primary.score = cross_source_boost(max(primary.score, other.score), len(merged_sources))
    return primary


def dedupe(places: list[Place]) -> list[Place]:
    """Merge same-physical-place records: same/adjacent ~0.35 mi grid cell
    and similar normalized names. Highest score wins identity."""
    places = sorted(places, key=lambda p: p.score, reverse=True)
    grid: dict[tuple[int, int], list[tuple[str, Place]]] = {}
    kept: list[Place] = []

    for p in places:
        ci, cj = _cell(p)
        pname = norm_name(p.name)
        winner = None
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for kname, kp in grid.get((ci + di, cj + dj), ()):
                    if kp.source != p.source and _similar(pname, kname):
                        winner = kp
                        break
                if winner:
                    break
            if winner:
                break
        if winner is not None:
            merge_into(winner, p)
        else:
            if not p.sources:
                p.sources = [p.source]
            kept.append(p)
            grid.setdefault((ci, cj), []).append((pname, p))
    return kept
