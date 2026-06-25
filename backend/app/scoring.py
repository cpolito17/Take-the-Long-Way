"""Scoring (spec §5): 0–100 per place. Traveler-interest signals lead,
notability/content-richness support. Raw counts go through log scaling so
mega-popular places don't crush everything else."""

import math


def _log(x: float) -> float:
    return math.log10(1.0 + max(0.0, x))


def clamp(score: float) -> float:
    return round(max(0.0, min(100.0, score)), 1)


def atlas_obscura(want_to_go: int, been_here: int) -> float:
    # Want-to-go / been-here counts are the dominant signal where present.
    return clamp(46 + 11 * _log(want_to_go) + 6 * _log(been_here))


def wikipedia(views_60d: int) -> float:
    # Monthly pageviews as a popularity proxy.
    return clamp(24 + 13 * _log(views_60d / 2.0))


def wikidata(sitelinks: int, identifiers: int = 0) -> float:
    # Language sitelinks / external identifiers as a notability proxy.
    return clamp(34 + 14 * _log(sitelinks) + 4 * _log(identifiers))


def osm(num_tags: int, has_wikipedia: bool) -> float:
    # Tag richness, with a strong bonus for a linked Wikipedia article.
    return clamp(20 + 2.5 * min(num_tags, 10) + (18 if has_wikipedia else 0))


def hmdb() -> float:
    # Curated by default. (The bulk CSV we cache has no photo/verification
    # fields, so HMDb gets a flat curated baseline.)
    return 38.0


def universal_boosts(score: float, has_image: bool, description: str) -> float:
    if has_image:
        score += 5
    if len(description or "") >= 80:
        score += 5
    return clamp(score)


def cross_source_boost(score: float, n_sources: int) -> float:
    # Multiple sources agreeing on the same physical place is a strong signal.
    return clamp(score + 9 * (n_sources - 1))
