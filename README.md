# Take the Long Way (TTLW)

*"Take the long way."*

A self-hosted road-trip discovery webapp: enter a start and end point (plus
optional stops), and TTLW finds the weird, overlooked, makes-you-think
places along your route — roadside oddities, ghost towns, folk art, strange
monuments — lets you pick the ones you like, and exports the finished trip
to Google Maps for navigation.

Built per [TTLW_spec.md](TTLW_spec.md). FastAPI backend + vanilla-JS
MapLibre frontend, one container, no database of user data (sessions live
in the browser).

## Quick start (Ubuntu server, Docker Compose)

```bash
cp .env.example .env        # then edit:
#   ORS_API_KEY   — your OpenRouteService key (openrouteservice.org, free)
#   TTLW_CONTACT  — your email; goes in the User-Agent (Wikimedia requires it)

docker compose build
docker compose run --rm app python -m app.pipeline   # one-time data build (~2 min)
docker compose up -d
```

Open `http://<server>:8080`. The pipeline writes `./data/places.db`
(~50k US places); re-run it occasionally to refresh. If `./data` already
contains a `places.db` (one is produced by a dev run of the pipeline), the
pipeline step can be skipped — the app uses whatever is mounted at `/data`.

## How it works

- **Routing**: OpenRouteService (multi-stop, up to 8 waypoints).
  **Geocoding**: Nominatim, proxied through the backend. **Tiles**: CartoDB
  Positron. The only secret is the ORS key.
- **Cached sources** (loaded by `python -m app.pipeline` into SQLite):
  Atlas Obscura, Historical Marker Database, Wikidata, Roadside America
  (see below). **Live per query**: OpenStreetMap (Overpass), Wikipedia
  Geosearch.
- Per search: ORS route → corridor buffer (user-set 5–75 mi) → score →
  keyword/source filters → cross-source de-dup → spatial de-clustering →
  ~100 results. Default order is **rank**: score × per-source confidence
  (sources with real popularity signals like Atlas Obscura's want-to-go
  counts lead; HMDb's flat curated baseline fills) minus a proximity
  penalty for sitting far off-route. The results panel adds client-side
  sorting (top picks / shortest detour / score / A–Z) and category filter
  chips; historical events ("Event" category — earthquakes, disasters,
  battles) are separable from currently visitable sites.
- Finalize computes baseline vs. with-stops stats via ORS and builds Google
  Maps directions links — one link when it fits, otherwise chained
  "Leg 1 / Leg 2" links (max 10 points each).

## Data source notes

| Source | Status | Swap/refresh |
|---|---|---|
| Atlas Obscura | Sapienza ADM-HW3 community TSV (late-2022 scrape, ~4.7k US places incl. want-to-go/been-here counts) | `ATLAS_OBSCURA_TSV_URL` env or replace `data/raw/atlas_obscura_merged.tsv`, re-run pipeline |
| HMDb | TidyTuesday 2023 bulk CSV (~41k US markers) | `HMDB_CSV_URL` env or replace `data/raw/hmdb_markers.csv` |
| Wikidata | Live SPARQL at pipeline time via QLever (WDQS rate limits are hostile; override with `WIKIDATA_SPARQL_URL`) | re-run pipeline |
| Roadside America | **No public dataset exists** (commercial site). Loader is a drop-in slot: place `data/raw/roadside_america.csv` with columns `name,lat,lng,description,url,image` and re-run | — |
| OSM / Wikipedia | Live per query, no setup | — |

## Verification

With the app running (`uvicorn` natively or the container):

```bash
python scripts/verify.py http://localhost:8080      # API: route → places → Maps links (31 checks)
node scripts/ui_test.js http://localhost:8080       # full browser flow (needs puppeteer-core + Edge/Chrome)
```

## Development (no Docker)

```bash
python -m venv .venv && .venv/Scripts/pip install -r backend/requirements.txt
cd backend
ORS_API_KEY=... TTLW_CONTACT=you@example.com python -m app.pipeline
ORS_API_KEY=... TTLW_CONTACT=you@example.com python -m uvicorn app.main:app --port 8000
```

Frontend is static (no build step), served by FastAPI from `frontend/`.

## Notes & limits

- ORS free tier: ~2,000 directions requests/day — plenty for personal use.
- A search fires ~25 Wikipedia calls and 1 Overpass query; long routes can
  take 15–45 s (the loading animation is doing load-bearing work).
- v2 ideas the architecture leaves room for (self-hosted
  geocoding/routing, AO scraper, accounts, share links) are listed in the
  spec §9 and deliberately not built.
