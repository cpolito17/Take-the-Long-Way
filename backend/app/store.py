"""Thin data-access wrapper over the local SQLite cache (spec §3: thin so a
source can move between cached and live without a rewrite). The pipeline
writes it; the API reads it with simple bbox queries."""

import json
import sqlite3
from pathlib import Path

from .models import Place

SCHEMA = """
CREATE TABLE IF NOT EXISTS places (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    category TEXT DEFAULT 'Other',
    source TEXT NOT NULL,
    sources TEXT DEFAULT '[]',
    source_url TEXT DEFAULT '',
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    image_url TEXT,
    score REAL DEFAULT 0,
    tags TEXT DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_places_lat_lng ON places (lat, lng);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
"""


def connect(db_path: Path) -> sqlite3.Connection:
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    return con


def init_db(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = connect(db_path)
    con.executescript(SCHEMA)
    return con


def write_places(con: sqlite3.Connection, places: list[Place]) -> None:
    con.executemany(
        """INSERT OR REPLACE INTO places
           (id, name, description, category, source, sources, source_url,
            lat, lng, image_url, score, tags)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        [
            (
                p.id, p.name, p.description, p.category, p.source,
                json.dumps(p.sources or [p.source]), p.source_url,
                p.lat, p.lng, p.image_url, p.score, json.dumps(p.tags),
            )
            for p in places
        ],
    )
    con.commit()


def _row_to_place(row: sqlite3.Row) -> Place:
    return Place(
        id=row["id"],
        name=row["name"],
        description=row["description"] or "",
        category=row["category"] or "Other",
        source=row["source"],
        sources=json.loads(row["sources"] or "[]"),
        source_url=row["source_url"] or "",
        lat=row["lat"],
        lng=row["lng"],
        image_url=row["image_url"],
        score=row["score"] or 0.0,
        tags=json.loads(row["tags"] or "[]"),
    )


def query_bbox(
    db_path: Path,
    bbox: tuple[float, float, float, float],
    sources: set[str] | None = None,
) -> list[Place]:
    """All cached places inside (min_lng, min_lat, max_lng, max_lat),
    optionally limited to a set of primary sources."""
    if not db_path.exists():
        return []
    min_lng, min_lat, max_lng, max_lat = bbox
    sql = "SELECT * FROM places WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?"
    args: list = [min_lat, max_lat, min_lng, max_lng]
    if sources:
        sql += f" AND source IN ({','.join('?' * len(sources))})"
        args.extend(sources)
    con = connect(db_path)
    try:
        return [_row_to_place(r) for r in con.execute(sql, args)]
    finally:
        con.close()


def stats(db_path: Path) -> dict:
    if not db_path.exists():
        return {}
    con = connect(db_path)
    try:
        rows = con.execute(
            "SELECT source, COUNT(*) AS n FROM places GROUP BY source"
        ).fetchall()
        return {r["source"]: r["n"] for r in rows}
    finally:
        con.close()
