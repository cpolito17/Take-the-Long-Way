# Deploying TTLW to `charliepolito.com/takethelongway`

TTLW runs as a single **Cloudflare Worker** (same pattern as Localize and
Apex): it serves the static frontend and answers the API under
`/takethelongway/api/*`. The place cache lives in **D1**; routing (ORS),
geocoding (Nominatim), Overpass and Wikipedia are called from inside the
Worker. The whole path is gated by **Cloudflare Access** so only you can
reach the app or spend the API quotas while testing.

```
Browser ──▶ Cloudflare Access (Google login, allow: cpolito@umich.edu)
             │
             ▼
        charliepolito.com/takethelongway/*  (Worker route)
             ├── /takethelongway/           → static assets (frontend/, no build step)
             └── /takethelongway/api/*      → Worker: search/finalize/geocode
                                               ├── secret ORS_API_KEY
                                               └── D1 "ttlw-places" (48,591 cached places)
```

Already done (state as deployed):

- Backend ported from Python/FastAPI to a TypeScript Worker (`worker/`);
  the Python original (`backend/`) stays as the reference implementation
  and still runs the data pipeline.
- `data/places.db` built by `python -m app.pipeline` and imported into the
  D1 database **`ttlw-places`** (id `040fe151-ffbe-42d0-b441-4220e3ccdcb5`),
  both remote and local (for `wrangler dev`).
- Worker deployed with routes `charliepolito.com/takethelongway` and `/*`.
- `frontend/js/api.js` switched to relative API paths so the app lives
  happily under the subpath.

The three steps below need your dashboards/login.

---

## 1. Set the OpenRouteService key (required for search)

The only secret. Get a free key at [openrouteservice.org](https://openrouteservice.org)
(~2,000 directions requests/day) and run:

```sh
npx wrangler secret put ORS_API_KEY     # paste the key when prompted
```

Verify: `curl https://charliepolito.com/takethelongway/api/health` →
`"ors_key_configured": true`.

For local dev, put the same key in `.dev.vars` (git-ignored):
`ORS_API_KEY="..."`.

## 2. Cloudflare Access — gate the path while testing

Your Zero Trust team and Google login method already exist from the
Localize setup, so this is just one new application:

1. Cloudflare dashboard → **Zero Trust → Access → Applications → Add an
   application → Self-hosted.**
2. Application name: `Take the Long Way`; session duration: your choice.
3. Public hostname: domain `charliepolito.com`, **path `takethelongway`**
   (scopes Access to `/takethelongway` and below, leaving the rest of the
   site untouched).
4. Identity provider: **Google**.
5. Policy: Allow → Include → Emails → `cpolito@umich.edu`.

Verify in an incognito window: `https://charliepolito.com/takethelongway/`
should bounce to Google login; a `curl` of the API health URL should return
the Access redirect, not JSON. When you're ready to open the app up, just
delete (or disable) this Access application — nothing in the Worker changes.

## 3. Connect the Worker to GitHub (deploy on push)

Workers Builds redeploys the Worker on every push to the repo — after this,
changes ship by `git push` with no local wrangler needed:

1. Dashboard → **Workers & Pages → takethelongway → Settings → Build →
   Connect** (Cloudflare calls it "Git repository" / Workers Builds).
2. Connect your GitHub account (installs the Cloudflare Workers & Pages
   GitHub app if you haven't) and pick **`cpolito17/Take-the-Long-Way`**,
   branch `main`.
3. Build settings:
   - **Build command:** `npm ci && npx tsc -p worker` (typecheck before deploy)
   - **Deploy command:** `npx wrangler deploy`
4. Save. Push a commit to `main` and watch the build in the Worker's
   "Deployments" tab.

Secrets (`ORS_API_KEY`) and the D1 binding live on the Worker, not in the
repo, so builds pick them up automatically.

---

## Local development

```sh
npm install
npm run dev          # wrangler dev on :8787 → open http://localhost:8787/takethelongway/
npm run check        # typecheck the Worker
npm run deploy       # typecheck + wrangler deploy (manual deploy path)
```

The local D1 copy is seeded from the same dump; re-seed with:

```sh
sqlite3 data/places.db .dump | grep -vE '^(PRAGMA|BEGIN TRANSACTION|COMMIT)' > data/places_dump.sql
npx wrangler d1 execute ttlw-places --local --file data/places_dump.sql -y
```

Cloudflare Access does not apply locally — that's edge-only.

## Refreshing the place data

The pipeline is still Python (it's a batch job; no reason to port it):

```sh
python3 -m venv .venv && .venv/bin/pip install -r backend/requirements.txt
cd backend && TTLW_CONTACT=cpolito@umich.edu ../.venv/bin/python -m app.pipeline && cd ..
sqlite3 data/places.db .dump | grep -vE '^(PRAGMA|BEGIN TRANSACTION|COMMIT)' > data/places_dump.sql
npx wrangler d1 execute ttlw-places --remote --file data/places_dump.sql -y
```

(The import replaces rows by primary key; to drop places that disappeared
from the sources, run `DELETE FROM places` remotely first.)

## Notes & limits

- **Workers free plan CPU (10 ms/request):** the corridor math runs
  comfortably for typical routes; very long routes (coast-to-coast at a
  75 mi radius) push tens of thousands of candidates through the filter and
  may hit the limit. If you see 1102 errors on long routes, the $5 Workers
  Paid plan (30 s CPU) removes the ceiling.
- A search fires up to ~30 Wikipedia calls + 1 Overpass + 1 ORS call —
  within the 50-subrequest free-plan limit.
- ORS free tier: ~2,000 directions/day; each search = 1 call, each
  finalize = 2.
