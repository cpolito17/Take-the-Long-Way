# PROJECT.md — Take the Long Way (TTLW)

The project overview you'd get from a senior engineer on day one. For known
problems see [GAPS.md](GAPS.md); for operational rules and commands see
[CLAUDE.md](CLAUDE.md); for the original product requirements see
[TTLW_spec.md](TTLW_spec.md) (the build spec — still the source of truth for
product intent).

## What this is

TTLW is a **road-trip discovery webapp** for one user (the repo owner,
deployed at `charliepolito.com/takethelongway` behind Cloudflare Access).
You enter a start point, an end point, and optional stops; it routes the
trip, finds *weird, overlooked, quirky* places within a corridor around the
route — roadside oddities, ghost towns, folk art, strange monuments — lets
you browse and select them on a map, and finally exports the trip to Google
Maps as directions links. It is a **planning tool, not a navigation app**:
navigation is always handed off to Google Maps at the end.

The single most important product constraint (spec §2): **the quality and
quirkiness of results is the whole point.** Fancy restaurants, big museums,
and obvious tourist stops are wrong answers. Every scoring/filtering
decision in the code biases toward the unusual. If a change makes results
more "normal travel guide," it's a regression even if all checks pass.

Scope: US only, no user accounts, no server-side user data — the working
session lives entirely in browser `localStorage`.

## The one thing you must understand first: two backends, one frontend

This repo contains **two parallel implementations of the same API**:

| | `backend/` (Python / FastAPI) | `worker/` (TypeScript / Cloudflare Worker) |
|---|---|---|
| Status | **Reference implementation** + still runs the data pipeline | **The deployed production app** |
| Serves | Docker/self-hosted path (README.md) | `charliepolito.com/takethelongway` (DEPLOY.md) |
| Place cache | SQLite file `data/places.db` | Cloudflare D1 database `ttlw-places` |
| Data pipeline | `python -m app.pipeline` (Python only — never ported, deliberately) | consumes the same data via `wrangler d1 execute --file` import |

The Worker was ported file-for-file from the Python backend (commit
`bf84e3f`). Nearly every `worker/*.ts` file has a header comment saying
which `backend/app/*.py` file it mirrors. **Any behavioral change to the
search/scoring/dedupe/geometry logic must be made in both places**, or the
two implementations drift (this is the project's biggest standing risk —
see GAPS.md #3). The frontend is shared verbatim: it's static vanilla JS
with no build step, served by FastAPI from `frontend/` in the Python path
and by the Worker's `ASSETS` binding in production.

## Tech stack and why

- **Frontend: vanilla JS ES modules + MapLibre GL JS + CartoDB Positron
  tiles.** No framework, no bundler, no build step — the spec fixed
  MapLibre/Positron (free, attribution-only, light basemap so pins stand
  out), and the app is small enough that a framework would only add a
  build step. GSAP (animations) and SortableJS (waypoint drag-reorder)
  come from CDNs in `index.html`.
- **Python backend: FastAPI + httpx + shapely.** The spec (§3) prescribed
  Python with a modern async framework. Shapely does the route-corridor
  geometry (distance-to-line, project-along-line).
- **Worker: plain TypeScript, no dependencies.** Cloudflare Workers can't
  run shapely, so `worker/geo.ts` reimplements the geometry (Douglas-Peucker
  simplification + per-segment projection). D1 replaces SQLite — same
  schema, same SQL. Chosen because the owner already hosts other apps
  ("Localize", "Apex") as Workers on the same domain, and the free tier
  fits personal use.
- **External services** (all fixed by spec §3): **OpenRouteService** for
  routing (the only secret, `ORS_API_KEY`; free tier ~2,000 requests/day),
  **Nominatim** for geocoding (proxied through the backend for a consistent
  User-Agent and no CORS), **Overpass** (OSM) and **Wikipedia Geosearch**
  as live per-query data sources.

## Architecture and data flow

```
                     ┌────────────────────────────────────────────┐
                     │ Browser (frontend/, vanilla JS, no build)   │
                     │  state in app.js · session in localStorage  │
                     └───────┬────────────────────────────────────┘
                             │ relative /api/* calls (api.js)
                             ▼
     ┌──────────────────────────────────────────────────────────────┐
     │ API (worker/index.ts in prod · backend/app/main.py for dev)  │
     │                                                              │
     │  GET  /api/health    – cache stats + ORS key check           │
     │  GET  /api/geocode   – proxies Nominatim (autocomplete)      │
     │  POST /api/search    – the core pipeline (below)             │
     │  POST /api/finalize  – baseline vs. with-stops stats +       │
     │                        Google Maps links                     │
     └──────┬──────────────┬──────────────┬──────────────┬─────────┘
            │              │              │              │
            ▼              ▼              ▼              ▼
     OpenRouteService   Overpass      Wikipedia     Place cache
     (routing, keyed)  (live OSM)    (geosearch)   (D1 / SQLite,
                                                    built offline by
                                                    python -m app.pipeline
                                                    from Atlas Obscura,
                                                    HMDb, Wikidata,
                                                    Roadside America)
```

### The search pipeline (the heart of the app)

`worker/search.ts` / `backend/app/search.py`, implementing spec §5:

1. **Route** the waypoints via ORS → polyline + distance/duration.
2. Build a **`RouteCorridor`** (`geo.ts`/`geo.py`): the polyline projected
   into a local equirectangular mile-space, simplified with 0.5 mi
   tolerance. Everything downstream is deliberately cheap approximation.
3. **Gather candidates in parallel**: bbox query against the place cache
   (cached sources: `atlas_obscura`, `hmdb`, `wikidata`, `roadside_america`),
   Overpass with per-60-mile segment bboxes (never one huge box), and
   Wikipedia geosearch at sample points every 11 mi (max 30 points, its
   radius caps at 10 km/call).
4. **Corridor filter**: keep candidates within `radius_mi` (user slider,
   5–75, default 25) straight-line of the route; record `offset_mi` and
   `along_mi` (position along route).
5. **Detour approximation**: `2 × offset × 1.35 (road circuity) @ 35 mph`.
   Shown as the `+XX mi / +XX min` badges. Intentionally not a real
   re-route — spec allows this.
6. **Keyword filter** (all tokens must appear in name/description/tags/
   category).
7. **Cross-source dedupe** (`dedupe.ts`/`dedupe.py`): ~0.35 mi grid cells +
   normalized-name similarity ≥ 0.62; higher score wins identity, merged
   record gets a +9/source cross-source boost.
8. **Rank** = `score × SOURCE_CONFIDENCE − proximity penalty (≤14)`.
   Confidence encodes how much a source's score reflects real traveler
   interest: Atlas Obscura 1.0 (want-to-go counts) … HMDb 0.58 (flat
   curated baseline, fills rather than leads).
9. **De-cluster**: bucket the route into segments, keep the top few per
   bucket, cap at ~110 results (soft target 100, spec says feel-based).

### Scoring (offline + live)

`scoring.py`/`scoring.ts`: 0–100 per place, log-scaled counts so
mega-popular places don't crush everything. Atlas Obscura uses want-to-go/
been-here counts; Wikipedia uses 60-day pageviews; Wikidata uses sitelinks;
OSM uses tag richness + Wikipedia-link bonus; HMDb is a flat 38. Universal
+5 boosts for images and substantive descriptions. Wikipedia's live results
are aggressively filtered by two regexes (`BORING_RE`, `BORING_TITLE_RE`)
that reject settlements, schools, highways, office buildings, etc. — this
filter is load-bearing for result quality.

### The data pipeline (Python only, offline)

`python -m app.pipeline` downloads/loads four static sources, normalizes
them into the unified `Place` record, scores, dedupes across sources, and
writes `data/places.db` atomically (~48k US places). Sources:

- **Atlas Obscura** — community TSV (Sapienza ADM-HW3 scrape, late-2022,
  ~4.7k US places with want-to-go/been-here counts). The flagship source.
- **HMDb** — TidyTuesday 2023 bulk CSV, ~41k historical markers.
- **Wikidata** — live SPARQL at pipeline time against **QLever**
  (`qlever.dev/api/wikidata`), not official WDQS, because WDQS rate limits
  made runs flaky. Seven curated "quirky" P31 classes (ghost town, roadside
  attraction, muffler man, …).
- **Roadside America** — an empty drop-in slot; no public dataset exists
  (commercial site). Drop a CSV at `data/raw/roadside_america.csv` and
  re-run.

Production refresh: rebuild `places.db`, dump to SQL, and
`wrangler d1 execute ttlw-places --remote --file …` (see DEPLOY.md).

### The frontend

`frontend/js/app.js` owns a single mutable `state` object and wires the
modules together; there is no framework or store, just callbacks:

- `form.js` — waypoint rows with Nominatim autocomplete (debounced 350 ms),
  add/remove/drag-reorder (SortableJS), radius slider, source toggles.
- `mapview.js` — MapLibre map. **Pins are a WebGL symbol layer, not DOM
  markers** (DOM markers lag the basemap while panning — this was a
  deliberate fix, don't regress it). One rasterized SVG icon per category ×
  selected-state, registered at 2× pixel ratio.
- `results.js` — polaroid result cards, client-side sort (top picks /
  shortest detour / score / A–Z) and category filter chips; on mobile it
  becomes a draggable bottom sheet.
- `finalize.js` — calls `/api/finalize`, plays the zoom + route-draw
  transition, renders the Trip Overview modal (mini-map, numbered stops,
  baseline-vs-trip stats, Google Maps links).
- `loading.js` — the loading overlay (car on a road, cycling copy). Its
  dismiss path is plain CSS on purpose — it must never depend on GSAP.
- `storage.js` — saves/restores the whole session under
  `ttlw_session_v1`; a "welcome back" banner offers Restore/Start Fresh.
- `constants.js` — the central `CATEGORY_COLORS` map (spec requires one
  place for category colors), map style URL, loading copy.

**Key state behavior that's easy to break:** selections persist across
searches. A trip is built over multiple searches (e.g. search Ann Arbor→
Chicago, pick things, change destination to Detroit, search again). Places
selected earlier but absent from the new results are "carried over" —
still shown in the list under an "from earlier searches" header and on the
map, with their detour recomputed client-side against the new route
(`recomputeDetour` in app.js). `ui_test.js` section 5 tests exactly this.

### Finalize / Google Maps handoff

`/api/finalize` routes the baseline (user waypoints only) and the full trip
(all selected stops inserted **in along-route order**, computed by
projecting each stop onto the baseline route). `gmaps.ts`/`gmaps.py` builds
`google.com/maps/dir/?api=1` links; ≤10 points fits one link, otherwise
batched "Leg N" links where each leg starts at the previous leg's end.

## Design decisions you should not casually reopen

- **Cheap geometry everywhere.** Equirectangular projection, straight-line
  corridor, out-and-back detour estimate. The spec explicitly allows this;
  precision is not the product.
- **Result quality > completeness.** The soft ~100 cap, the de-cluster
  bucketing, the Wikipedia boring-filter, and the OSM tag whitelist all
  exist to keep the list quirky and browsable. Widening any of them floods
  the UI with mediocrity.
- **No user database.** Session is localStorage by design (spec §3). v2
  ideas (accounts, share links, self-hosted routing) are listed in spec §9
  as *design-for-don't-build*.
- **Pipeline stays Python.** It's a batch job; there's no reason to port
  it to the Worker.
- **The only secret is `ORS_API_KEY`.** Everything else is public
  endpoints identified by a polite User-Agent containing `TTLW_CONTACT`
  (Wikimedia's robot policy requires contact info — don't remove it).

## Critical paths (ranked)

1. **`search.ts`/`search.py` + `geo.*` + `dedupe.*` + `scoring.*`** — the
   product. Changes here change what users see. Verify with
   `scripts/verify.py` against a running instance.
2. **`worker/index.ts` routing/validation** — production entry point,
   including the `/takethelongway` subpath handling (strip prefix, map to
   ASSETS; `html_handling = "none"` in wrangler.toml exists so ASSETS never
   redirects the browser to the site root — don't change it).
3. **`app.js` selection/carry-over logic and `storage.js`** — subtle,
   stateful, covered only by `ui_test.js`.
4. **The pipeline sources** — each parses a specific community dataset's
   quirks (stray whitespace in AO headers, `NA` sentinels in HMDb,
   POINT-string coords from SPARQL). Breakage here silently degrades the
   cache.
5. Safe to change casually: CSS, loading copy, pin/placeholder SVGs,
   category colors (keep them in `constants.js`).

## Non-obvious things that will trip you up

- **Coordinate order flips.** API/GeoJSON/ORS use `[lng, lat]`; Google
  Maps links and `gmaps.build_links` use `(lat, lng)`; Wikipedia geosearch
  takes `lat|lng`. Every off-by-one bug in this codebase's history is this.
- **`config.py` has a `WIKIDATA_SPARQL_URL` that is NOT what the pipeline
  uses** — `pipeline/sources/wikidata.py` reads the env var itself with a
  *different* default (QLever). See GAPS.md #6.
- **Worker free-plan CPU limit (10 ms)**: coast-to-coast routes at 75 mi
  radius can 1102. Known, documented in DEPLOY.md, unresolved.
- **Cloudflare Access gates production** — `curl` of the prod API returns
  an Access redirect, not JSON. That's expected while testing; it means
  `scripts/verify.py` can only run against local/dev instances.
- **`ui_test.js` only knows Windows browser paths** (it was written on a
  Windows dev box). On Linux, point it at Chromium by editing
  `EDGE_PATHS` (GAPS.md #8). In the Claude Code cloud environment, Chromium
  is at `/opt/pw-browsers/chromium`.
- **Deploys on push to `main`** via Cloudflare Workers Builds (build:
  `npm ci && npx tsc -p worker`, deploy: `npx wrangler deploy`). A push to
  `main` that typechecks IS a production deploy.
- **The frontend intentionally uses relative `api/...` URLs** (no leading
  slash) so it works under the `/takethelongway/` subpath and at root in
  local dev. Don't "fix" them to absolute paths.
- **`data/` is git-ignored.** The place cache and raw datasets are build
  artifacts; a fresh clone has no data until you run the pipeline (or, for
  Worker dev, seed local D1 per DEPLOY.md).
- **Rounding style differs** between Python (`round()`, banker's) and JS
  (`Math.round`) — a known cosmetic ±0.1 divergence between the two
  backends. Don't chase it as a bug.
