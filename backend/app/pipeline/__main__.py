"""Pipeline entry point: python -m app.pipeline

Loads every static source, de-dupes across sources, writes data/places.db.
Safe to re-run any time; it rebuilds the table from scratch.
"""

import logging
import sys
import time

from .. import config, store
from ..dedupe import dedupe
from .sources import atlas_obscura, hmdb, roadside_america, wikidata

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("pipeline")

LOADERS = {
    "atlas_obscura": atlas_obscura.load,
    "roadside_america": roadside_america.load,
    "wikidata": wikidata.load,
    "hmdb": hmdb.load,
}


def main() -> int:
    t0 = time.time()
    all_places = []
    failures = []
    for name, loader in LOADERS.items():
        try:
            t = time.time()
            places = loader()
            log.info("%-18s %6d places  (%.1fs)", name, len(places), time.time() - t)
            all_places.extend(places)
        except Exception:
            log.exception("source %s FAILED — continuing with the rest", name)
            failures.append(name)

    if not all_places:
        log.error("No places loaded from any source; not writing the database.")
        return 1

    log.info("De-duplicating %d records across sources...", len(all_places))
    merged = dedupe(all_places)
    log.info("%d records after merge (%d duplicates folded in)",
             len(merged), len(all_places) - len(merged))

    tmp = config.DB_PATH.with_suffix(".db.tmp")
    if tmp.exists():
        tmp.unlink()
    con = store.init_db(tmp)
    store.write_places(con, merged)
    con.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('built_at', datetime('now'))"
    )
    con.commit()
    con.close()
    if config.DB_PATH.exists():
        config.DB_PATH.unlink()
    tmp.rename(config.DB_PATH)

    log.info("Wrote %s in %.1fs  per-source: %s",
             config.DB_PATH, time.time() - t0, store.stats(config.DB_PATH))
    if failures:
        log.warning("Sources that failed and were skipped: %s", ", ".join(failures))
    return 0


if __name__ == "__main__":
    sys.exit(main())
