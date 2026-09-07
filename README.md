# Take the Long Way

Take the Long Way is a free road trip detour planner for finding unusual places between your starting point and destination. It searches for roadside attractions, folk art, ghost towns, historic markers, ruins, monuments, and other memorable stops near your route, then builds a Google Maps-ready itinerary.

**Live app:** [charliepolito.com/takethelongway](https://charliepolito.com/takethelongway/)

**Portfolio:** [charliepolito.com](https://charliepolito.com/)

**Source:** [github.com/cpolito17/Take-the-Long-Way](https://github.com/cpolito17/Take-the-Long-Way)

## What it does

- Plans a driving route with up to eight user waypoints.
- Searches a configurable corridor around that route.
- Combines cached Atlas Obscura, HMDb, Wikidata, and optional Roadside America data with live OpenStreetMap and Wikipedia results.
- Ranks and de-duplicates stops, with filters for category, source, keyword, and detour distance.
- Compares the direct route with the selected detours.
- Exports the finished trip as one or more Google Maps directions links.
- Saves the working trip only in the browser; the app has no accounts or user database.

## Architecture

The production app runs on Cloudflare:

- `frontend/` contains the static, dependency-free browser interface.
- `worker/` contains the TypeScript Worker and JSON API.
- Cloudflare D1 stores the public place index.
- OpenRouteService provides driving routes.
- Nominatim, Overpass, and Wikipedia provide live public place data.
- `backend/` retains the original FastAPI implementation and the Python data-import pipeline.

The app deliberately lives under `/takethelongway/`. Frontend URLs are relative, and the Worker maps that prefix to the bundled static assets.

## Local development

Requirements: Node.js, npm, and an [OpenRouteService](https://openrouteservice.org/) API key.

```bash
npm install
```

Create a git-ignored `.dev.vars` file:

```dotenv
ORS_API_KEY="your-key"
```

Then start the Worker and open `http://localhost:8787/takethelongway/`:

```bash
npm run dev
```

The checked-in Wrangler configuration expects a D1 database named `ttlw-places`. See [DEPLOY.md](DEPLOY.md) for data seeding and Cloudflare setup.

## Useful commands

```bash
npm run check
npx wrangler deploy --dry-run
npm run deploy
```

`npm run deploy` publishes to the configured Cloudflare account, so use the dry run for routine validation.

## Configuration and secrets

Non-secret production configuration lives in `wrangler.toml`. Set the routing credential through Wrangler rather than committing it:

```bash
npx wrangler secret put ORS_API_KEY
```

`TTLW_CONTACT` is a public contact value used in User-Agent headers for community APIs. Override service base URLs only with trusted HTTPS endpoints.

## Data refresh

The Python pipeline in `backend/app/pipeline/` builds the public place catalog before it is imported into D1. Source-specific notes and refresh instructions are documented in [DEPLOY.md](DEPLOY.md) and [TTLW_spec.md](TTLW_spec.md).

Roadside America does not publish an official bulk dataset. Its loader is optional and expects a locally supplied CSV; no Roadside America data is scraped at request time.

## Security and privacy

- The OpenRouteService key remains a Worker secret and is never sent to the browser.
- API requests enforce JSON content type, payload size, coordinate bounds, waypoint limits, and stop limits.
- The Worker applies clickjacking, MIME-sniffing, referrer, and browser-permission response protections.
- Third-party place text is escaped before rendering, and generated outbound links are restricted to HTTPS.
- Trip state is stored in the visitor's local storage. Clearing site data removes it.
- Native Cloudflare rate limits protect geocoding separately from the more expensive routing and trip-generation endpoints.

If you discover a security issue, please report it privately through [charliepolito.com](https://charliepolito.com/) rather than opening a public issue with exploit details.

## Project documentation

- [DEPLOY.md](DEPLOY.md) — Cloudflare deployment and D1 setup
- [PROJECT.md](PROJECT.md) — implementation notes and system design
- [TTLW_spec.md](TTLW_spec.md) — original product specification
- [GAPS.md](GAPS.md) — known limitations and future improvements

## License

No open-source license is currently included. Copyright remains with the repository owner unless a license is added.
