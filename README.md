# Ahmedabad Metro

Routes, fares, stations, timetables and a multilingual assistant for the Ahmedabad–Gandhinagar Metro — one
Next.js app (pages and API together), in English, Hindi and Gujarati.

It is the TypeScript migration of the original React (CRA) + FastAPI app. The metro logic and the
chatbot's instant answers are pinned to that implementation by golden tests: every route between every
pair of stations, every fare, every departure table and almost 2,000 chatbot messages give the same
result, field for field.

## Features

- **Journey planner** (`/routes`): quickest route, legs and line changes, fare, journey time, next timetabled
  trains, alternatives, drawn on a map along the real track.
- **Metro map** (`/stations`): schematic diagram and street map; per station: lines, next trains, gates and
  lifts, fares to every other station, "plan from / to here".
- **Nearest stations** (`/nearest-stations`): from your location, a place search or a pasted Google Maps
  link, with walking distance and path.
- **Assistant** (chat widget): fares and routes answered instantly from the app's data in all three
  languages; everything else by a LangGraph agent on Gemini with tools and a knowledge base, with racing
  models, a circuit breaker and a knowledge-base fallback when every model is down.
- Schedule, facilities, station information, contact; light and dark theme; live visit counter.

## Getting started

Requires [Bun](https://bun.sh) 1.x.

```bash
bun install
cp .env.example .env    # optional: Gemini key, Upstash Redis, weather key
bun run dev             # http://localhost:3000
```

| Command | |
|---|---|
| `bun run dev` / `bun run build` / `bun run start` | Next.js dev server, production build, production server |
| `bun run test` | Vitest: golden parity, API, chatbot agent (scripted model, no network), UI |
| `bun run lint` / `bun run typecheck` | ESLint, TypeScript |
| `bun run data:network` | Rebuild `src/data/network.json` from the sheets in `data/` |
| `bun run data:tracks` | Refresh `data/tracks.json` (metro track) from OpenStreetMap |

## Configuration

All optional; see [.env.example](.env.example).

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | none | The chatbot's agent. Without it, rule answers still work; other questions return 503. |
| `GEMINI_MODELS` | `gemini-2.5-flash-lite:0,gemini-3.5-flash-lite:minimal` | Models in race order, as `model:thinking` (a token budget for Gemini 2.x, a level for Gemini 3). |
| `GEMINI_TEMPERATURE`, `GEMINI_MAX_OUTPUT_TOKENS` | `0.2`, `1024` | |
| `LLM_CONCURRENCY` | `8` | Model calls running at once. |
| `CHAT_LIMIT_PER_MINUTE` | `20` | Chat messages per client IP per minute. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | none | Shared state in Upstash Redis (also `KV_REST_API_URL` / `KV_REST_API_TOKEN`). |
| `REDIS_PREFIX` | `metro` | Key prefix in Redis. |
| `VISITS_FILE` | `.data/visits.json` | Where the visit total is saved when Redis isn't configured. |
| `NEXT_PUBLIC_WEATHER_API_KEY`, `NEXT_PUBLIC_WEATHER_CITY` | none, `Ahmedabad,IN` | OpenWeatherMap for the home page. |
| `RENDER_EXTERNAL_URL` / `KEEPALIVE_URL` | set by Render | When present, the server pings its own `/health` every 10 minutes between 06:00 and 23:00 IST. |
| `KEEPALIVE_INTERVAL_SECONDS`, `KEEPALIVE_START_HOUR`, `KEEPALIVE_END_HOUR` | `600`, `6`, `23` | |

### Shared state: Upstash Redis

The visit total, who is online, the per-IP limits (visits and chat), the chatbot's answer cache and the
models' cooldowns live in a small store (`src/server/store.ts`). With Upstash credentials it is Redis, shared
by every server instance and kept across deploys. Without them it lives in the server process, as the FastAPI
backend did, and the visit total is saved to `.data/visits.json`.

## Deploying

- **Render**: `render.yaml` describes the web service (build with Bun, `bun run start`). Add `GEMINI_API_KEY`,
  and the Upstash variables so the visit count survives deploys (Render's free disk is wiped on each one).
- **Vercel** (or any serverless host): works with Upstash Redis configured; without it each function instance
  keeps its own counters. The chat endpoint streams for up to 60 s (`maxDuration`).

## Project layout

```
src/
  app/              pages (/, /routes, /stations, ...) and API routes (src/app/api/*)
  components/       the UI (ported from the CRA app)
  domain/metro/     network and routing, fares, timetable, nearby stations, the network build
  domain/chat/      the assistant: rules, retrieval, tools, agent, orchestration
  server/           HTTP helpers, the shared store, visit counter, keep-alive, endpoint payloads
  i18n/  lib/       translations; client-side network data, theme, router helpers
  data/             runtime data: network.json, timetable.json, metro_kb.txt, stationData.json
data/               build inputs: Location.xlsx, Fare Matrix.xlsx, tracks.json
tests/              Vitest suites and golden fixtures (tests/fixtures/golden)
scripts/            data:network / data:tracks, golden capture (Python, against the original backend), spikes
```

## Updating stations, lines or fares

The app reads `src/data/network.json`, built from `data/Location.xlsx` and `data/Fare Matrix.xlsx`. After
editing either sheet, rebuild it; the build checks the data and lists any corrections it made:

```bash
bun run data:network
```

Lines are drawn along the real track, saved in `data/tracks.json` from OpenStreetMap. After a new line or
extension opens, refresh it before rebuilding:

```bash
bun run data:tracks
bun run data:network
```

## API

| Endpoint | |
|---|---|
| `GET /api/stations`, `/api/lines`, `/api/stations/coordinates` | Network data |
| `POST /api/route` `{source, destination}` | Route, legs, time, next trains, alternatives |
| `POST /api/fare` `{source, destination}` | `{fare}` |
| `GET /api/fares/from?station=` | Fares to every other station |
| `GET /api/departures?station=` | Next timetabled trains |
| `GET /api/stations/nearby?lat=&lng=` | Three nearest open stations |
| `POST /api/location/resolve-google-maps` `{url}` | Coordinates from a Google Maps link |
| `POST /api/chat/stream` `{message, history}` | Server-sent events: `delta` pieces, then `done` |
| `GET/POST /api/visits`, `GET /api/visits/stream` | Visit counter, live via server-sent events |
| `GET /health` | `{status: "ok"}` |
