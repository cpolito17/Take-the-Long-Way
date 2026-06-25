# Take the Long Way (TTLW) — Project Specification

*"Take the long way."*

---

## How to use this document

This is the build spec for a self-hosted road-trip discovery webapp. It defines the product, the features, and the decisions already made. It intentionally does **not** prescribe file structure, frameworks beyond the external services named below, or exact algorithms — those are yours to design.

Before building: read the whole spec, then ask any clarifying questions that would *materially* change the build. If nothing is blocking, scope the work and execute it end to end. Don't pause for confirmation on reversible decisions that clearly follow from this spec.

While building: don't add features, services, or abstractions beyond what's described here. Do the simplest thing that works well. There's a "v2 — design for, don't build" section at the end; treat it as a list of things *not* to build now. Establish a way to verify the app actually runs (containers come up, endpoints return real data, a sample route produces selectable results) and check against it as you go rather than at the end.

---

## 1. What we're building

A road-trip planning tool that helps people **get off the beaten path**. The user enters a start and end point (and optional stops in between); the app finds genuinely interesting, quirky places along that route and lets the user browse them, pick the ones they like, and export the finished trip to Google Maps for navigation.

This is **not** a navigation app. It's a discovery and planning tool. Navigation is handed off to Google Maps at the very end. We never route turn-by-turn ourselves.

**Who it's for:** people planning long road trips — often multi-city — who want to find the weird, overlooked, makes-you-think places they'd otherwise drive straight past.

**Scope for v1:** United States only. No user accounts. State persists in the browser so a returning visitor can pick up where they left off.

---

## 2. The thing that matters most

The **interesting locations are the entire selling point.** Everything else is packaging around this.

We are explicitly **not** interested in fancy restaurants, big museums, or obvious tourist stops. We want the deep cuts: roadside oddities, folk-art environments, ghost towns, strange monuments, vernacular architecture, the stuff that makes someone go "wait, what *is* that?" If a result feels like something you'd find in a normal travel guide, it's probably the wrong kind of result.

The quality and quirkiness of results is the bar this whole project is judged against. When making trade-offs, bias toward surfacing the unusual.

---

## 3. Decisions already made

These are settled. You don't need to re-open them, and they answer the most likely questions up front.

**External services & infra (fixed):**
- **Map rendering:** MapLibre GL JS.
- **Map tiles:** CartoDB Positron (free, attribution-only, no key). Chosen deliberately — it's light and clean so the location pins stand out.
- **Routing:** OpenRouteService public API (free tier). It accepts a list of waypoints natively, which is what makes multi-stop cheap to support. An API key will be supplied via environment variable.
- **Geocoding** (address → coordinates): Nominatim public endpoint.
- **Deployment target:** Docker (Docker Compose) running on a personal Ubuntu server. Fully self-hosted. The only required external secret is the OpenRouteService key.

**Backend language:** Python with a modern async framework (FastAPI is the recommended choice) — it's the best fit for the data-wrangling this app does and is production-ready for a later public release. If you have a strong reason to choose otherwise, flag it; otherwise go with this.

**Internal architecture, file structure, and code organization:** your call. Design what's clean and maintainable.

**Caching vs. live fetch:** Cache the static/slow data sources locally (estimated well under 1 GB total, so disk is not a concern). Fetch the fast/always-changing sources live per query. The data-access layer should be a thin wrapper so switching a source between cached and live later is a small change, not a rewrite. (It is genuinely easy to change later — don't over-engineer for it now.)

**Corridor search:** Keep it computationally simple. Define "along the route" as a straight buffer of N miles around the route line (user-controlled width). It does not need to be exact or detour-time-based — it's just a filter to avoid drowning the user in results.

**Result cap (~100):** This is a *soft quality gate*, not a hard UI cap. The goal is to keep results focused and high-quality, generally under ~100 for a typical route, using scoring + de-clustering (see §5). The number is a feel-based target, not a strict rule.

**Multi-stop routing:** Supported in v1. The user can add intermediate stops, not just origin + destination. This is a primary use case (long trips between multiple cities). Support up to ~8 waypoints total. ORS handles the routing; the bulk of the work is the UI for adding/removing/reordering stops.

**Persistence:** No database of user data, no accounts in v1. Persist the user's working session in the browser (localStorage) so closing and reopening the tab restores their trip-in-progress.

**Mobile:** Must be mobile-friendly. The desktop layout (form top-left, results list on the right) needs a different mobile treatment — see §6 and §7.

**Geographic scope:** US only, limited by data-source coverage, not by architecture. Rural areas will sometimes be sparse; that's acceptable. The wide range of sources is the mitigation.

---

## 4. Data sources

The locations come from multiple curated and open sources, normalized into one unified internal format. v1 sources:

| Source | What it gives us | Access approach |
|---|---|---|
| **Atlas Obscura** | The flagship source — exactly the quirky, curated places we want | Community-scraped static dataset (CSV from a public GitHub/Kaggle source — confirm the specific dataset before building the pipeline). No official public API exists. |
| **Roadside America** | The best thematic fit for roadside oddities | Community static dataset |
| **Wikidata** | Geolocated cultural/historic/unusual items with structured type tags (folk art, roadside attraction, ghost town, etc.) | Public SPARQL endpoint, cached locally |
| **Historical Marker Database (HMDb)** | 200k+ geolocated, categorized physical historical markers | API, cached locally |
| **OpenStreetMap** | Community-tagged oddities under `tourism=*` / `historic=*` | Overpass API, live per query |
| **Wikipedia Geosearch** | Articles with marked coordinates, with pageview data as a popularity signal | Wikipedia API, live per query |

A one-time (and periodically re-runnable) setup step should load the static/cached sources, normalize them, compute base scores, and de-duplicate across sources (entries from different sources that are the same physical place — close coordinates + similar names — should be merged, not shown twice).

**Unified location record** (conceptual — fields, not a schema to copy): a stable id, name, short description, a category (e.g. Roadside / Historical / Natural / Art / Weird / Ruins / Community / Other), the source it came from, a link back to the source page, latitude/longitude, an image URL where available, a base score, and tags. Per-query, each record also carries its computed distance from the route and its approximate added detour distance and time.

If you know of additional strong US sources that fit the "quirky deep cuts" brief, you may suggest them, but don't add new live integrations to v1 without flagging first.

---

## 5. Scoring & narrowing (concept, not formulas)

The hard problem is returning a focused, high-quality set rather than everything within the corridor. Two mechanisms handle this: a per-location **score**, and a **filtering pipeline** that caps results.

**Scoring (0–100 per location).** Each source contributes a base score from the best available signal of "is this notable / loved / substantial":
- **Atlas Obscura:** its "want to go" and "been here" counts are excellent proxies for traveler interest — these should be the dominant signal where present.
- **Wikipedia:** monthly pageviews (via the free Wikimedia pageviews API) as a popularity proxy.
- **Wikidata:** number of language sitelinks / external identifiers as a notability proxy.
- **OpenStreetMap:** richness of tagging, with a strong bonus when the feature has a linked Wikipedia article.
- **HMDb:** treated as curated by default, with photo count and verification as boosters.
- **Universal boosts:** presence of an image and a substantive description.

Use diminishing-returns scaling (e.g. logarithmic) on the raw count signals so a few mega-popular places don't crush everything else. Cross-source matches discovered during de-duplication should be boosted (multiple sources agreeing is a strong signal). Tune the exact weights and curves yourself — the principle is what matters: traveler-interest signals lead, notability and content-richness support.

**Filtering pipeline (per search).** Roughly:
1. Get the route polyline from ORS.
2. Build a bounding box around the route plus the user's radius, and gather candidates: query the local cache and fire the live sources (OSM, Wikipedia) for that box.
3. Filter candidates to those actually within the straight buffer around the route line.
4. Compute each one's approximate added detour — distance and time — relative to the route. This can be a cheap approximation (it does not need to be exact); show it to the user as `+XX mi` and `+XX min`.
5. Apply the user's keyword filter (against name / tags / description) and source filter.
6. **De-cluster spatially** so the user doesn't get fifteen things within a couple miles of each other — segment the route and keep only the top-scoring few per segment. This is the main lever for keeping the set under ~100.
7. Return sorted by score, capped at the soft target.

---

## 6. Features

### 6.1 Route & search form

A small panel anchored **top-left** on desktop (a compact collapsible bar at the top on mobile). It contains:

- **Waypoints:** Origin and Destination by default. The user can **add intermediate stops** (up to ~8 total), **reorder** them via drag handle, and **remove** them. Each field is an address input with autocomplete backed by Nominatim.
- **Keyword search:** a free-text field (e.g. "Art", "Attraction", "Park", "Food"). Sent to the backend as a fuzzy filter.
- **Advanced options** (collapsed by default, expands on click):
  - **Search corridor width:** a radius slider, roughly 5–75 miles, default ~25. Controls the buffer in §5.
  - **Source toggles:** checkboxes to include/exclude each data source (Atlas Obscura, Roadside America, OpenStreetMap, Wikipedia, Wikidata, Historical Markers), all on by default.
- **Search button:** triggers the search and the loading animation.

### 6.2 Map

MapLibre GL JS filling the rest of the viewport, with CartoDB Positron tiles.

- **Route line:** styled GeoJSON, warm amber, with a subtle glow.
- **Location pins:** custom SVG markers styled like little vintage road signs. **Color varies by category** (defined in one central category-color constant). Unselected pins are smaller; selected (checked) pins are larger and carry a checkmark.
- **Hover (desktop) / tap (mobile) on a pin** shows a brief info card: name, a one-sentence description, an image thumbnail, the category, and the two **detour badges** — `+XX mi` and `+XX min` — each shown as a small icon-led chip (a little car/road icon for miles, a clock icon for minutes).
- **Pin ↔ list link:** clicking a pin highlights and scrolls to its card in the results list, and selecting a card highlights its pin. Selection state stays in sync both ways.

### 6.3 Results list (POI panel)

On **desktop**, a scrollable vertical list to the **right** of the map. On **mobile**, a bottom drawer/sheet (peeks at the bottom showing the top result; drag up to expand; has a grab handle).

- Sorted by score, highest first.
- Each card shows: image thumbnail (or a category placeholder illustration when none exists), name, a category badge, a source badge, a one-line teaser, the `+XX mi` / `+XX min` detour badges, and a **checkbox** to select it.
- Toggling a card's checkbox updates the matching map pin.
- A sticky **"Finalize Trip"** button sits at the bottom of the panel, enabled once at least one place is selected, showing the selected count.

### 6.4 Loading animation

Plays as a full-screen overlay **while the route and locations are being fetched** (not on initial page load). Over a dimmed map:

- A main animation of **a car driving down a road from an isometric perspective** — winding road, passing trees, animated road dashes, gentle parallax on fore/background layers, a slight bob on the car.
- Cycling progress copy in the brand's playful voice (e.g. *"Plotting your route…" → "Digging through the archives…" → "Finding the weird stuff…" → "Almost there…"*).
- Dismisses when results arrive.

Make this genuinely fun and detailed — the loading moment is part of the brand, not an afterthought.

### 6.5 Finalize flow & Trip Overview

When the user clicks **Finalize Trip**, play a satisfying transition, then open the **Trip Overview** as a modal in the **center** of the screen.

Suggested transition: the map zooms to fit all selected places, the route line animates drawing itself forward along the path, then the Trip Overview scales in from center.

**Trip Overview modal contains:**
- A **mini-map** showing the finalized route with only the selected pins (read-only).
- A **numbered list** of the selected stops (name, category, detour values).
- **Trip stats:**
  - Baseline route: total miles / total drive time for the direct origin→destination (through any required intermediate waypoints) route.
  - Your route: total miles / total drive time with all selected stops included.
  - Added: `+XX mi` / `+XXh XXm` over the baseline.
  - A note that actual time will vary by how long they spend at each stop. **Do not show arrival times** — we can't know dwell time.
- The **"Open in Google Maps"** export (see §7).
- An **"Edit Trip"** action that returns to the main view with all selections preserved.

### 6.6 Session persistence

On meaningful state changes, save the working session to the browser (localStorage): the waypoints, the search options (radius, keyword, sources), the fetched results, the selected place ids, and the current route/stats. On load, if a saved session exists, restore it and show a dismissable "welcome back, we saved your last trip" banner with Restore / Start Fresh options.

---

## 7. Google Maps handoff

The finished trip exports to Google Maps as a directions link with the selected places loaded as waypoints, in route order.

- Google Maps directions links support up to ~10 points (origin + destination + waypoints).
- If the selection fits in a single link, show **one** "Open in Google Maps" button.
- If it exceeds the limit, **batch into multiple links shown as separate buttons** ("Open Leg 1 in Google Maps", "Open Leg 2…"), where each subsequent leg starts where the previous one ended, so the legs chain together. If you find a cleaner approach to handing off a long itinerary, you may propose it — but batched leg links are the accepted default.

---

## 8. UI / UX & design system

**Design language:** vintage explorer / adventure travel. Worn paper maps, retro road-trip postcards, national-park signage. It should feel like a travel journal, not a tech app — adventurous, warm, and a little playful. The whole point of the tool is helping people get off the beaten path and notice things they'd otherwise miss, and the branding should carry that spirit.

**Color palette (starting point — refine as needed):**
- Background: warm parchment (`#F5EFE0`)
- Primary: dusty amber / road-sign orange (`#D4760E`)
- Secondary: forest green (`#2D6A4F`)
- Accent: rust / terracotta (`#8B4A2B`)
- Dark: near-black (`#1A1A2E`)
- Panel background: off-white (`#FDFAF3`)

**Typography:**
- Display / headings: an editorial, slightly vintage face (e.g. Playfair Display or Abril Fatface).
- UI / body: a clean, readable sans (e.g. Inter or DM Sans).
- Monospace accents for coordinates and distances (e.g. JetBrains Mono).

**Map markers:** custom SVG styled like vintage enamel signs or pushpins, one distinct color per category, defined centrally.

**Location cards:** Polaroid-style — photo on top, text below, soft drop shadow, a subtle paper texture.

**Buttons:** rounded, bold, slightly tactile — a small offset bottom shadow gives a "stamp" / pressable feel.

**Iconography:** a clean icon set as the base (e.g. Lucide), plus custom SVG for the detour badges — a small car icon for miles and a clock icon for time, styled like little vintage gauges.

**Animation:** use a capable animation library so the loading scene, the finalize transition, and the mobile drawer all feel smooth and intentional. Motion is part of the brand here.

**Mobile transitions:** the results panel becomes a spring-animated bottom sheet; the search form collapses into a compact pill at the top once a search is active.

---

## 9. v2 — design for, don't build

Leave room for these, but **do not build them now**. Architecture should not preclude them, that's all.

- Self-hosted geocoding (replace public Nominatim) and self-hosted routing (replace ORS) for higher traffic / offline use.
- A scheduled, rate-limited Atlas Obscura scraper to replace the static dataset.
- User accounts and saved trips (would introduce a real database).
- Community "I visited this" signals feeding back into scoring.
- Shareable trip links.
- Expansion beyond the US (blocked only by data coverage, not architecture).

When the time comes, the public-traffic changes are mostly swapping a public endpoint for a keyed/self-hosted one plus adding the usual rate-limiting and input hardening — the current design intentionally doesn't dig a hole here.

---

## 10. Two things to confirm before the data pipeline

1. **App name** is **Take the Long Way (TTLW)**. Use it in the branding, the loading copy, and the container/image names. Tagline: *"Take the long way."*
2. **Atlas Obscura dataset:** the build needs a specific community CSV source (a public Kaggle or GitHub dataset). Confirm which one before wiring up the data pipeline, since it's the flagship source.
