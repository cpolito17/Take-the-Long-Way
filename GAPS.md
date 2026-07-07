# GAPS.md — Honest audit of weaknesses

Ordered by severity, most important first. Each entry: what, where, why it
matters, and a fix scoped small enough to execute as a single task.
Architecture context is in [PROJECT.md](PROJECT.md).

---

## 1. XSS: attribute injection via unescaped quotes in place names — **Security, HIGH**

**What:** `escapeHtml()` in the frontend escapes `&`, `<`, `>` but **not
`"`**, yet its output is interpolated into double-quoted HTML attributes.
The concrete sink: `frontend/js/results.js:104` —
`aria-label="Add ${escapeHtml(p.name)} to trip"` on the card checkbox.
Place names come from external data, including **OpenStreetMap, which is
world-editable**. A crafted OSM `name` tag like
`x" onfocus="alert(document.cookie)" autofocus="` breaks out of the
attribute and executes script in the user's browser.

**Where:** `frontend/js/results.js` (the `aria-label` sink and the
`escapeHtml` at :240). Same too-weak `escapeHtml` is duplicated in
`frontend/js/mapview.js:276` and `frontend/js/finalize.js:160` (currently
only used in text contexts there, but one refactor away from a sink).
`frontend/js/mapview.js:225` also interpolates `place.id` into `data-id="…"`
unescaped (ids are backend-constructed, lower risk).

**Why it matters:** Script execution in the app origin; can read/poison the
localStorage session. Mitigated today only by Cloudflare Access limiting
who can *view* the app — the data-source attack surface is still open.

**Fix (single task):** Add `"` → `&quot;` (and ideally `'` → `&#39;`) to
every `escapeHtml` in `results.js`, `mapview.js`, `finalize.js`, and escape
`place.id` where interpolated into attributes. Then run
`node scripts/ui_test.js` to confirm nothing rendered breaks.

---

## 2. Zero unit tests; the only tests need live external APIs and a key — **Test coverage, HIGH**

**What:** There are no unit tests at all. Verification is two end-to-end
scripts (`scripts/verify.py`, `scripts/ui_test.js`) that require a running
server, a real `ORS_API_KEY`, and live Overpass/Wikipedia/Nominatim. There
is also no CI — the only automated gate is `tsc` during Cloudflare Workers
Builds.

**Why it matters:** The highest-value logic is pure and deterministic —
`scoring`, `dedupe`, `categorize`, `gmaps.build_links`, `RouteCorridor`
geometry, `decluster` — and every one of them is untested in isolation, in
**two implementations that must stay behaviorally identical** (see #3).
Any regression ships silently to production on push to `main`.

**Fix (single task, can be split per module):** Add pure-function tests
that need no network: `backend/tests/test_scoring.py`, `test_dedupe.py`,
`test_gmaps.py`, `test_geo.py` (pytest; fabricate small Place lists and a
synthetic polyline), and mirror them for the Worker with `vitest` (the
worker code has no runtime deps; `dedupe.ts`, `scoring.ts`, `gmaps.ts`,
`geo.ts`, `categories.ts` all import cleanly). Especially valuable: a
shared JSON fixture asserted against by *both* suites to pin Python/TS
parity on dedupe and ranking.

---

## 3. Dual implementation (backend/ vs worker/) with no drift guard — **Tech debt / process, HIGH**

**What:** The entire API exists twice: Python (`backend/app/`, the
"reference implementation") and TypeScript (`worker/`, production). Sync is
by hand and by comment ("Mirrors backend/app/x.py"). Drift already exists
in small ways: TS name-similarity uses LCS ratio vs Python's
`difflib.SequenceMatcher` (different algorithm, same threshold 0.62,
`worker/dedupe.ts:21` vs `backend/app/dedupe.py:32`); the Worker doesn't
default a stop's missing `category` to `"Other"` while pydantic does
(`worker/index.ts:91` vs `backend/app/models.py:71` — a stop posted without
`category` renders an "undefined" badge in the Trip Overview); rounding
semantics differ (banker's vs `Math.round`).

**Why it matters:** Every future logic change is a chance for the two to
disagree; the Python one silently rots because nothing runs it in
production.

**Fix (single task):** Cheapest meaningful guard: the shared-fixture parity
test from #2. Also fix the concrete `category` default divergence in
`worker/index.ts` (default missing `category`/`name` when echoing
`ordered_stops`). Longer-term (separate decision for the owner): declare
the Python API server deprecated and keep only the pipeline, or delete the
Worker comments claiming exact mirroring where untrue.

---

## 4. No rate limiting or abuse hardening on the API — **Security, MEDIUM (HIGH the day Access is removed)**

**What:** All four endpoints are unauthenticated and unthrottled at the
app layer. `/api/geocode` is an open proxy to Nominatim (usage policy:
max 1 req/s, ban risk); `/api/search` fans out to ~30 Wikipedia calls +
1 Overpass + 1 ORS call per request; ORS free tier is ~2,000/day.

**Where:** `worker/index.ts` (`handleApi`), `backend/app/main.py`.

**Why it matters:** Today Cloudflare Access (allow-list: one email) gates
production, so exposure is low. But DEPLOY.md's stated plan is "when you're
ready to open the app up, just delete the Access application — nothing in
the Worker changes." The day that happens, anyone can drain the ORS quota
and get the Worker's egress IPs rate-limited/banned by Nominatim and
Overpass. Spec §9 acknowledges this as v2 work; it's still the largest
future footgun.

**Fix (single task):** Add a small per-IP token bucket in the Worker (e.g.
Cloudflare rate-limiting bindings or a KV/DO counter): geocode ~1/s,
search ~6/min, finalize ~6/min, returning 429 with a friendly `detail`.
Keep it in `worker/index.ts` so the Python reference is unaffected.

---

## 5. Worker input validation is thinner than the Python reference — **Correctness/robustness, MEDIUM**

**What:** Python gets pydantic validation for free; the Worker validates by
hand and misses cases:
- `worker/index.ts:47` — `body.sources` is used as
  `(req.sources ?? []).filter(...)` in `search.ts:53`; a non-array (string,
  object) throws `TypeError` → 500 "Internal error" instead of 422.
- `isWaypoint` accepts `NaN`/`Infinity` lat/lng (`typeof NaN === "number"`),
  which then flow into ORS requests and corridor math.
- `keyword` is not type-checked (a number would throw at `.trim()` → 500).
- Finalize `stops` items aren't required to carry `id`/`name` (checked only
  as waypoints), then echoed back cast as `SelectedStop`.

**Where:** `worker/index.ts:30–61`, `worker/search.ts:52–54`.

**Why it matters:** Malformed requests produce 500s instead of 422s, and
NaN coordinates produce confusing ORS errors. Low user impact today
(the only client is the bundled frontend), but it's the production entry
point.

**Fix (single task):** Extend `handleSearch`/`handleFinalize`:
`Number.isFinite(lat/lng)` and range checks (lat −90..90, lng −180..180) in
`isWaypoint`; `Array.isArray(sources)` and `typeof keyword === "string"`
with 422 on failure; require `id: string`/`name: string` on stops.

---

## 6. Dead + misleading config: `config.WIKIDATA_SPARQL_URL` — **Inconsistency, MEDIUM**

**What:** `backend/app/config.py:12` defines
`WIKIDATA_SPARQL_URL = env or "https://query.wikidata.org/sparql"`, but the
only consumer, `backend/app/pipeline/sources/wikidata.py:28`, ignores it
and re-reads the env var itself with a *different* default
(`https://qlever.dev/api/wikidata`). The env override still works, but the
config constant is dead code and documents the wrong default (README says
QLever is the default, which matches the pipeline, not config.py).

**Why it matters:** Anyone reading config.py to understand behavior gets
the wrong answer; a future change to the constant would silently do
nothing.

**Fix (single task):** In `config.py`, change the default to the QLever URL
and have `wikidata.py` use `config.WIKIDATA_SPARQL_URL` instead of its own
`os.environ.get`. One-line change each side; re-run the pipeline to verify.

---

## 7. Workers free-plan CPU ceiling on long routes — **Fragile edge case, MEDIUM**

**What:** Coast-to-coast routes at a 75 mi radius push tens of thousands of
cached candidates through `offsetAndAlong` per candidate
(`worker/geo.ts:155` — O(candidates × polyline segments)) and can exceed
the 10 ms free-plan CPU limit → Cloudflare 1102 errors. Documented in
DEPLOY.md as "buy the paid plan," but unhandled in code. Relatedly, a huge
bbox `SELECT *` (`worker/store.ts:42`) can brush D1 response-size limits.

**Why it matters:** The flagship use case in the spec is *long* multi-city
trips — the exact input most likely to fail.

**Fix (single task):** In `worker/store.ts`, add a spatial pre-cut: query
per corridor-segment bboxes (reuse `segmentBboxes`, already implemented for
Overpass) instead of one route-spanning bbox, deduping rows by id. That
cuts candidates for diagonal routes by ~5–10×. Alternatively/additionally,
add an early coarse grid filter before the exact `offsetAndAlong`.

---

## 8. `ui_test.js` only runs on Windows — **Test coverage / portability, MEDIUM**

**What:** `scripts/ui_test.js:14-18` hardcodes three Windows Edge/Chrome
paths; on any other OS it prints "No Edge/Chrome found" and exits 2. It
also needs `puppeteer-core`, which isn't in `package.json` devDependencies.

**Why it matters:** The only test of the frontend's stateful logic
(carry-over selections, sheet, finalize modal) can't run in the deploy
environment (Linux CI, Claude Code cloud where Chromium is at
`/opt/pw-browsers/chromium`).

**Fix (single task):** Accept an executable path from env
(`BROWSER_PATH || EDGE_PATHS.find(...)`), append common Linux paths
(`/usr/bin/chromium`, `/usr/bin/google-chrome`, `/opt/pw-browsers/chromium`),
and add `puppeteer-core` to devDependencies.

---

## 9. Unstable IDs for Roadside America; stale Atlas Obscura snapshot — **Data quality, MEDIUM-LOW**

**What:**
- `backend/app/pipeline/sources/roadside_america.py:63` assigns
  `id=f"ra:{i}"` (CSV row index). Any reorder/insert in a future dataset
  changes every ID, silently breaking saved-session selections and
  dedupe stability across pipeline reruns.
- Atlas Obscura data is a late-2022 community scrape of ~4.7k US "most
  popular" places (of AO's much larger catalog); counts and URLs age, and
  no refresh path exists beyond swapping the TSV (README table documents
  this honestly).
- Roadside America itself is an **empty slot** — loader exists, no dataset
  does. The UI still shows its source toggle, which can never return
  results (`frontend/index.html:57`).

**Why it matters:** Quiet data rot in the flagship sources; a source
checkbox that never does anything erodes user trust.

**Fix (single task each):** (a) Derive `ra:` ids from a content hash of
`name|lat|lng` instead of the index. (b) Hide the Roadside America toggle
when `/api/health` cache stats report zero `roadside_america` rows (health
data is already fetchable; small JS change in `form.js`/`app.js`).

---

## 10. README and DEPLOY tell two different deployment stories — **Docs inconsistency, LOW**

**What:** `README.md` is written Docker-first ("Quick start (Ubuntu server,
Docker Compose)") and never mentions the Worker; `DEPLOY.md` says the
production path is the Cloudflare Worker and the Python app is a reference.
A newcomer following README builds the non-production stack.

**Fix (single task):** Add a short "Which stack am I looking at?" section
at the top of README pointing Docker users onward and linking DEPLOY.md
for the deployed path (and PROJECT.md for architecture).

---

## 11. Deprecated FastAPI startup hook — **Tech debt, LOW**

**What:** `backend/app/main.py:21` uses `@app.on_event("startup")`,
deprecated since FastAPI 0.93 in favor of lifespan context managers.
`requirements.txt` allows `fastapi>=0.115,<1`, so this emits deprecation
warnings now and breaks on a future major.

**Fix (single task):** Replace with
`app = FastAPI(lifespan=lifespan)` + an `@asynccontextmanager` lifespan
that runs the same cache/key checks.

---

## 12. Silent truncation and swallowed errors in data fetching — **Fragile edge cases, LOW**

**What:**
- Overpass query ends with `out center tags 900;`
  (`backend/app/services/overpass.py:32`, `worker/services/overpass.ts:37`):
  results silently cap at 900 elements; dense long corridors lose OSM data
  with no signal.
- `worker/store.ts:64` — `stats()` catches *all* errors and returns `{}`,
  so `/api/health` can't distinguish "empty DB" from "DB broken."
- Overpass/Wikipedia failures degrade to empty lists with only a server
  log; the user sees fewer results with no hint a source failed
  (`overpass.py:88`, `wikipedia.py:83`, and the TS mirrors).

**Fix (single task):** Add a `sources_failed: string[]` field to
`SearchResponse` populated when a live source errors, and surface a small
notice in `results.js`. Separately, log (don't swallow) the error in
`worker/store.ts stats()`.

---

## 13. Cheap-geometry edge cases: Alaska/antimeridian, single-point degeneracy — **Fragile edge cases, LOW**

**What:** The equirectangular mile-space (`geo.py:20`,
`worker/geo.ts:54`) uses one reference latitude for the whole route
(distance distortion for very long north-south routes) and naive
`lng BETWEEN` bbox SQL (`store.py:89`, `store.ts:48`) that breaks across
the ±180° antimeridian — relevant only to far-west Aleutian routes. US
mainland use is unaffected; ORS coverage there is spotty anyway.

**Why it matters:** Barely — documenting so nobody burns a day debugging a
"missing places near Adak" report.

**Fix:** Accept as a documented limitation (this entry), or split bboxes at
±180° in `query_bbox` if it ever matters.

---

## 14. Frontend duplication: escapers and detour constants — **Tech debt, LOW**

**What:** `escapeHtml` is defined three times (`results.js:240`,
`mapview.js:276`, `finalize.js:160`), `escapeAttr` twice with different
semantics (`form.js:182` HTML-escapes; `mapview.js:279` percent-encodes),
and the detour constants (circuity 1.35, 35 mph) are hardcoded in a third
place at `app.js:150-151` (`recomputeDetour`) in addition to
`config.py`/`config.ts`. Whoever fixes #1 must touch all copies.

**Fix (single task):** Create `frontend/js/util.js` exporting one
`escapeHtml` (incl. quotes), one URL-attr escaper, and
`ROAD_CIRCUITY`/`DETOUR_AVG_MPH`; import everywhere. Pure refactor, verify
with `ui_test.js`.

---

## 15. Housekeeping — **LOW**

- `.gitignore` has duplicate lines (`node_modules/`, `.wrangler/`,
  `.dev.vars` each appear twice). Fix: dedupe the file.
- No `LICENSE` file (matters only if the repo is ever public — data-source
  licenses would also need review then).
- `scripts/verify.py`'s README blurb says "31 checks"; count drifts as
  checks are edited — remove the number from README.
- The welcome-back banner shows for any saved session with a named
  waypoint, even if the user never searched (no results/route saved) —
  restoring then does almost nothing. Cosmetic; guard on
  `saved.results?.length || saved.selected?.length` in `app.js:193` if it
  annoys.

---

## Explicitly *not* gaps (by design — don't "fix" these)

- Detour numbers are approximations (spec §5 allows it).
- The pipeline is Python-only and the Worker imports its output.
- No accounts, no server-side persistence, sessions in localStorage.
- Result cap ~100 is a soft, feel-based target.
- v2 items in spec §9 (self-hosted routing/geocoding, AO scraper, share
  links) are deliberately unbuilt.
