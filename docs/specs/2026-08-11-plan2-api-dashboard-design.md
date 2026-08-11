# Plan 2 Design: API + Dashboard + Persistence

Approved 2026-08-11. Implements the api / persistence / dashboard sections of
`docs/specs/2026-08-10-orchestrator-design.md`. Companion: `docs/HANDOFF-plan2-dashboard.md`
(mission, parallel-session file-ownership rule), `docs/BACKLOG.md`.

## Goal

Make the orchestrator visible and operable: REST/WS API + live web dashboard +
optional Postgres persistence. This layer is screen-recorded for the President
Tech Award video (deadline 31 Aug) — demo quality is a first-class requirement.

## Hard constraints

- **File ownership:** a parallel session owns `packages/orchestrator/src/orchestrator.ts`,
  `packages/core/src/router.ts`, `packages/sim/test/e2e.test.ts`. This plan adds NEW
  packages only and edits no existing package source. Missing hooks are recorded in
  `docs/PLAN2-HOOK-REQUESTS.md` and worked around (10Hz `snapshot()` polling is the
  accepted v1 workaround). Merge order: fix branch lands first, this branch rebases.
- No docker / no brew installs on this machine. No real Postgres or Mosquitto locally.
- pnpm only via `corepack pnpm`; `.npmrc workspace-concurrency=1` stays.
- All 149 existing tests + `tsc --noEmit` stay green. ESM, strict TS, `.js` import
  extensions, vitest.
- License gate: MIT / Apache-2.0 / BSD / EPL / ISC only.

## Decisions resolved in brainstorm

1. **Local persistence engine: pglite** (`@electric-sql/pglite`, Apache-2.0,
   in-process WASM Postgres). One SQL dialect and one schema shared with prod
   Postgres (`pg` driver via `DATABASE_URL`). The swap is driver-only behind a
   repository interface. better-sqlite3 rejected: dialect divergence (no JSONB)
   would force two SQL flavors.
2. **Dashboard IA: cockpit + tabs.** Main tab = single-screen ops cockpit
   (rmf-web-style); plus Orders tab (history table) and Analytics tab (KPI trends).

## Packages

### 1. @tez/persistence (new)

Repository interface + Postgres implementation.

- **Driver seam:** one `SqlDriver` interface (`query(sql, params)` + lifecycle);
  implementations `PgliteDriver` (local/demo: file dir or in-memory) and
  `PgDriver` (prod: `pg` pool via `DATABASE_URL`). Identical SQL against both.
- **Schema (per system spec):** `robots`, `transport_orders`,
  `transport_order_history` (append-only audit), `missions`,
  `state_snapshots` (JSONB raw VDA state; retention = delete-older-than on
  interval, default 24h), `kpi_snapshots`.
- **Migrations:** plain ordered `NNN_name.sql` files + a tiny built-in runner
  (tracked in `schema_migrations` table). No ORM.
- **Repositories:** `OrderRepo`, `RobotRepo`, `SnapshotRepo`, `KpiRepo` — thin,
  typed, no business logic.
- **Optionality:** the whole layer is a peer the api may or may not wire in.
  Nothing in api's request path requires a DB.

### 2. @tez/api (new)

Fastify + `@fastify/websocket` + `@fastify/swagger` (OpenAPI) service wrapping
one `Orchestrator` instance.

- **Composition root** (`src/main.ts`), config via env:
  - `DEMO=1` → `FakeAdapter` (lockstep), no broker needed.
  - Otherwise → `Vda5050Adapter` against `MQTT_URL`; `DEV_BROKER=1` additionally
    starts the in-repo aedes broker (`startDevBroker`, ephemeral ports in tests).
  - `DATABASE_URL` (prod pg) or `PGLITE_DIR` (local) → persistence wired;
    neither → stateless in-memory.
  - Map from `MAP_FILE` or built-in demo layout (the proven clean 3-robot layout
    from `packages/orchestrator/test/vda5050-integration.test.ts`).
- **REST** (all bodies/queries Typebox-validated, OpenAPI auto-generated):
  - `POST /orders`, `DELETE /orders/:id` (cancel), `GET /orders`
    (live from orchestrator; `?history=1` adds DB audit when persistence is on)
  - `GET /robots`
  - `PUT /map` (upload), `GET /map`
  - `GET /kpi` (live counters; `?range=` queries `kpi_snapshots` when DB on)
  - `GET /health` (broker/DB/orchestrator status)
- **WS `/ws/state`:** one stream, 10Hz batched frames assembled from
  `snapshot()` polling + `adapter.on(...)` events: robot poses/state/battery,
  order statuses, alarms, connection flags. Full-state frame on connect, then
  deltas-as-full-batches (v1 keeps frames full — simpler, fine at 50 robots).
- **Persistence writes:** order lifecycle events append to
  `transport_order_history`; state + KPI snapshots on interval. All writes
  fire-and-forget with error logging — DB failure never blocks the control loop
  or a request.

### 3. @tez/dashboard (new)

React 18 + TS + Vite SPA.

- **Tabs:** Cockpit / Orders / Analytics — state-based tab switch in zustand,
  no routing dep.
- **Cockpit:** PixiJS v8 + pixi-viewport map, center-dominant — floor grid,
  racks, robot sprites with heading, active paths, click-to-select; right rail
  robot cards (battery, state, errors, current order); bottom strip task queue +
  KPI row; alarm badge in header + slide-over drawer.
- **Orders tab:** history table (status filter, time range; live-only when no DB).
- **Analytics tab:** Recharts KPI trends (throughput, utilization, queue depth).
- **Data flow:** WS client (reconnect with backoff, status indicator) →
  zustand store → React for chrome/cards/tables; Pixi layer subscribes to the
  store imperatively, sprite updates rAF-batched — 60fps at 50 robots. No
  React re-render per frame.
- **Design:** shadcn/ui + Tailwind; brand cobalt `#4F46E5`, IBM Plex Sans +
  JetBrains Mono; dark theme default (filmed). Layout patterns mined from
  rmf-web (Apache-2.0), no code copied from GPL tools.
- **i18n:** RU/UZ/EN, keys and tone carried from `orchestrator-demo/src/i18n.ts`;
  hand-rolled dictionary hook (no i18n framework dep).

### 4. Demo scenario (`corepack pnpm demo` at repo root)

One command for screen recording: boots api with `DEMO=1` (FakeAdapter,
lockstep, proven clean layout) + seeded order flow (scripted submits with
staggered timing) + dashboard dev server; prints URL. Variant
`demo:vda` runs sim fleet + dev broker + Vda5050Adapter for the full-protocol
version. Implemented as root `scripts/demo.ts` wired into root `package.json`,
no new package.

## Error handling

- Broker down: api keeps serving last cached snapshot read-only; WS frames carry
  `degraded: true`; reconnect handled by adapter/broker layer.
- DB down or slow: log warn, drop the write, continue stateless. Health endpoint
  reports it.
- WS client (dashboard): exponential backoff reconnect, visible connection
  status chip, store keeps last state.
- All REST input validated (Typebox); invalid → 400 with schema error, never a crash.

## Testing

- **persistence:** repository + migration tests against in-memory pglite.
- **api:** REST via `fastify.inject` (no port); WS via real client on ephemeral
  port; composition tested with `FakeAdapter` (+ orchestrator `tickOnce` where
  determinism needed). One integration test: submit order → WS reflects
  progression → history row written (pglite).
- **dashboard:** vitest + happy-dom for store, WS client (mock server), i18n,
  and component smoke; Pixi rendering verified manually (it gets filmed).
- Full-repo gate before merge: `corepack pnpm -r test` + `tsc --noEmit` green
  (filter to new packages during dev; full run at the end).

## Dependency licenses (checked)

| Dep | License |
|---|---|
| @electric-sql/pglite | Apache-2.0 |
| pg | MIT |
| fastify, @fastify/websocket, @fastify/swagger | MIT |
| @sinclair/typebox | MIT |
| pixi.js v8, pixi-viewport | MIT |
| zustand | MIT |
| react, vite | MIT |
| tailwindcss, shadcn/ui (vendored source) | MIT |
| recharts | MIT |
| @fontsource/ibm-plex-sans, @fontsource/jetbrains-mono (font files) | SIL OFL-1.1 |

No AGPL/GPL anywhere (Grafana embed and bekirbostanci tools stay out).

**Owner-approved gate exception (2026-08-11):** the stated license gate
("MIT / Apache-2.0 / BSD / EPL / ISC only") is a code-package gate; it does
not fit font files, which the type foundry world licenses almost
exclusively under SIL OFL-1.1 (not one of the listed code licenses).
`@fontsource/ibm-plex-sans` and `@fontsource/jetbrains-mono` ship IBM Plex
Sans and JetBrains Mono, both OFL-1.1-licensed font assets bundled as npm
packages purely for their static font files (no executable license terms
beyond OFL's font-specific reciprocity, which doesn't propagate to
surrounding application code). The owner approved OFL-1.1 as allowed for
font files on this basis. All code packages (everything else in this table)
remain MIT/Apache-2.0/BSD/EPL/ISC as originally gated — this exception is
scoped to font assets only.

## Out of scope

Auth beyond nothing/basic token env check, multi-warehouse, VDA 3.0, 1C
connector (Plan 3), editing any fix-session-owned file, pushing to the public
remote (owner decision).

## Milestones

1. **M1 — @tez/api skeleton + DEMO mode:** Fastify boots FakeAdapter orchestrator,
   REST orders/robots/health, WS stream live. Testable end-to-end, no DB, no UI.
2. **M2 — @tez/persistence:** schema + migrations + repos on pglite; api wires it
   when configured; history/KPI endpoints gain DB paths.
3. **M3 — @tez/dashboard cockpit:** Vite app, WS client + store, Pixi map,
   robot cards, task queue, KPI row, alarms. Demo script (`pnpm demo`).
4. **M4 — tabs + polish:** Orders + Analytics tabs, i18n, design-quality pass
   (filmed), full-repo test gate, rebase readiness.
