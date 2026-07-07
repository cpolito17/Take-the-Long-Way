# CLAUDE.md — Take the Long Way (TTLW)

Road-trip discovery webapp. **Read [PROJECT.md](PROJECT.md)** for
architecture and design rationale; **[GAPS.md](GAPS.md)** lists known bugs,
debt, and scoped fixes; **[TTLW_spec.md](TTLW_spec.md)** is the product
spec (source of truth for intent); **[DEPLOY.md](DEPLOY.md)** covers the
production Cloudflare deployment.

## The rule that governs everything

The API exists **twice**: `backend/app/` (Python/FastAPI, reference
implementation + data pipeline) and `worker/` (TypeScript Cloudflare
Worker, **production**). Files mirror each other 1:1 (each `.ts` header
names its `.py` counterpart). **Any change to search/scoring/dedupe/
geometry/gmaps logic must be applied to BOTH implementations.** The
frontend (`frontend/`, vanilla JS, no build step) is shared by both.

**Pushing to `main` deploys to production** (Cloudflare Workers Builds:
`npm ci && npx tsc -p worker` then `wrangler deploy`). Work on a branch.

## Commands

```sh
# Worker (production stack)
npm install
npm run check        # tsc -p worker — the only lint/typecheck gate; run before every commit
npm run dev          # wrangler dev on :8787 → http://localhost:8787/takethelongway/
npm run deploy       # typecheck + wrangler deploy (manual; normally push to main instead)

# Python backend (reference stack, also runs the pipeline)
python3 -m venv .venv && .venv/bin/pip install -r backend/requirements.txt
cd backend && ORS_API_KEY=... TTLW_CONTACT=you@example.com \
  ../.venv/bin/python -m uvicorn app.main:app --port 8000
cd backend && TTLW_CONTACT=you@example.com ../.venv/bin/python -m app.pipeline  # rebuild data/places.db (~2 min, downloads datasets)

# Verification (no unit tests exist — see GAPS.md #2)
python scripts/verify.py http://localhost:8000   # e2e API checks; needs running server + real ORS_API_KEY
node scripts/ui_test.js http://localhost:8000    # browser e2e; needs puppeteer-core + Chrome (Windows paths hardcoded — GAPS.md #8)

# Refresh production place data (pipeline output → D1)
sqlite3 data/places.db .dump | grep -vE '^(PRAGMA|BEGIN TRANSACTION|COMMIT)' > data/places_dump.sql
npx wrangler d1 execute ttlw-places --remote --file data/places_dump.sql -y
```

Secrets: `ORS_API_KEY` only. Locally: `.env` (Docker) or `.dev.vars`
(wrangler), both git-ignored. Production: `wrangler secret put ORS_API_KEY`.
Never commit a key; never remove `TTLW_CONTACT` from User-Agents
(Wikimedia requires contact info).

## Conventions

- **Python:** module-per-concern under `backend/app/` (`search`, `geo`,
  `dedupe`, `scoring`, `store`, `gmaps`), external services in
  `app/services/`, pipeline loaders in `app/pipeline/sources/`. Pydantic
  models in `models.py`. Config = env vars with defaults in `config.py`.
  Errors: raise `HTTPException(status, detail)`.
- **Worker:** same file names as Python, TS strict mode, **no runtime
  dependencies**. Errors: throw `ApiError(status, detail)` (types.ts);
  `index.ts` converts to `{detail}` JSON. Env via the `Env` interface +
  `DEFAULTS` in `config.ts`.
- **Frontend:** ES modules, one class per file (`SearchForm`, `MapView`,
  `ResultsPanel`, `FinalizeFlow`, `LoadingOverlay`). Single mutable `state`
  object owned by `app.js`, passed into modules; modules signal back via
  handler callbacks. No framework, no bundler — keep it that way.
  Persist state via `saveSession(state)` after meaningful changes.
- **API responses** use snake_case fields (`detour_mi`, `image_url`);
  errors are `{detail: string}` and the frontend surfaces `detail`
  verbatim.
- Categories are the fixed list in `models.py`/`categories.*`:
  Roadside, Historical, Event, Natural, Art, Weird, Ruins, Community,
  Other. Colors live ONLY in `frontend/js/constants.js`
  (`CATEGORY_COLORS`).

## Gotchas

- **Coordinate order:** GeoJSON/ORS/API = `[lng, lat]`; Google Maps links =
  `lat,lng`; Wikipedia geosearch = `lat|lng`. Check twice.
- Frontend API calls use **relative** paths (`api/search`, no leading
  slash) so the app works under `/takethelongway/`. Don't make them
  absolute.
- `wrangler.toml` sets `html_handling = "none"` on ASSETS because the
  Worker maps the subpath itself; changing it breaks prod routing with
  redirects to the site root.
- Map pins are a MapLibre **symbol layer** (WebGL), not DOM markers — DOM
  markers lag during panning. Icons are pre-rasterized per
  category × selected state (`pin-<Cat>-sel|unsel`).
- Selections **survive new searches** ("carried over" places): `app.js`
  keeps `state.selected` as full place objects and recomputes their detours
  client-side against the new route. Don't reset `state.selected` on
  search.
- The loading overlay's dismiss path is plain CSS on purpose — must never
  depend on GSAP being loaded.
- `data/` is git-ignored; fresh clones have no place cache. The Python app
  still runs (live sources only) but logs a warning; Worker dev needs the
  local D1 seed (DEPLOY.md "Local development").
- Production is behind **Cloudflare Access** — curling the prod API returns
  a login redirect, not JSON. Test against local instances.
- `config.py`'s `WIKIDATA_SPARQL_URL` is dead — the pipeline reads the env
  var itself with a different default (QLever). See GAPS.md #6 before
  touching Wikidata config.
- Python `round()` (banker's) vs JS `Math.round` cause ±0.1 differences
  between backends. Cosmetic, known, not a bug.
- The `frontend/js/*` `escapeHtml` helpers do NOT escape quotes — do not
  interpolate their output into HTML attributes (existing bug: GAPS.md #1).

## Do not change without care

- Scoring weights/curves (`scoring.py`/`scoring.ts`), `SOURCE_CONFIDENCE`,
  `PROXIMITY_PENALTY` (`search.*`), the Wikipedia `BORING_RE` filters, the
  OSM `NODE_FILTERS` tag whitelist, and `decluster` parameters — these ARE
  the product ("quirky results" is the whole selling point, spec §2). If
  you tune them, run `scripts/verify.py` and eyeball the top results for a
  sample route.
- Dedupe thresholds (`GRID_DEG = 0.005`, `NAME_SIM_THRESHOLD = 0.62`) —
  used by BOTH the offline pipeline and live queries.
- `ROAD_CIRCUITY = 1.35` / `DETOUR_AVG_MPH = 35` exist in **three** places:
  `config.py`, `worker/config.ts`, and inline in `app.js:recomputeDetour`.
  Change all three together.
- Route order/patterns in `wrangler.toml`, and the D1 binding — production
  wiring.
- Nothing in this repo is generated code; the closest thing is
  `data/places.db` (pipeline output, git-ignored) — never hand-edit it,
  re-run the pipeline.

## Verifying a change

1. `npm run check` (typecheck — required).
2. If logic changed: start a local server (either stack) with a real
   `ORS_API_KEY` and run `python scripts/verify.py <base-url>`.
3. If frontend/state changed: run `scripts/ui_test.js` (browser path
   caveat in GAPS.md #8) or manually drive: search Ann Arbor → Chicago,
   select a place, change destination, search again (selection must carry
   over), finalize, check the Google Maps links.
4. Remember: whatever you changed in `worker/` likely needs the same change
   in `backend/app/` (and vice versa).
