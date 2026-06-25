"""One-time (and periodically re-runnable) data pipeline: loads the static
sources, normalizes them into the unified place record, scores, de-dupes
across sources, and writes the local SQLite cache (spec §4).

Run with:  python -m app.pipeline
"""

US_BBOXES = [
    # (min_lat, max_lat, min_lng, max_lng)
    (24.3, 49.5, -125.0, -66.8),   # contiguous US
    (51.0, 71.6, -179.9, -129.0),  # Alaska
    (18.5, 22.5, -160.6, -154.5),  # Hawaii
]


def in_us(lat: float, lng: float) -> bool:
    return any(
        a <= lat <= b and c <= lng <= d for (a, b, c, d) in US_BBOXES
    )
