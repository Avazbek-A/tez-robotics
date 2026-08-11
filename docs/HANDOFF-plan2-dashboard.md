# Handoff: Plan 2 — API + Dashboard (+ persistence)

Written 2026-08-11. Self-contained brief for a fresh session. Companions in this repo: `docs/specs/2026-08-10-orchestrator-design.md` (full system spec — Plan 2 implements its api/persistence/dashboard sections), `docs/BACKLOG.md`, `docs/HANDOFF-p0-router-fixes.md` (the PARALLEL fix session — read its scope to respect the no-touch rule below).

## Mission

Make the orchestrator visible and operable: REST/WS API + live web dashboard + Postgres persistence. This is the layer that gets screen-recorded for the President Tech Award video (deadline 31 Aug) — demo impact matters as much as engineering.

## HARD RULE — parallel-session file ownership

A parallel session is fixing P0/P1 and OWNS these files: `packages/orchestrator/src/orchestrator.ts`, `packages/core/src/router.ts`, `packages/sim/test/e2e.test.ts`. This session must NOT edit any existing package's source — build ONLY new packages (`packages/api`, `packages/dashboard`, and if needed `packages/persistence` or fold into api). Consume existing public APIs: `Orchestrator` (constructor, start/stop, submitOrder, snapshot(), tickOnce test hook), `RobotAdapter` events via `adapter.on(...)`, `Vda5050Adapter`, `FakeAdapter`, `startDevBroker`, `WarehouseMap`, `spawnFleet` from @tez/sim. If a needed hook is missing inside owned files, write the need into `docs/PLAN2-HOOK-REQUESTS.md` and work around it (polling snapshot() at 10Hz is an acceptable v1 workaround) — do not edit. Merge order: fix branch lands first, this branch rebases (should be trivial — additive packages only).

## Scope (from design spec)

1. **@tez/api** — Fastify + @fastify/websocket service wrapping an Orchestrator instance:
   - REST: submit/cancel orders, list orders (+history), robots, map upload/get, KPI query. OpenAPI via fastify plugin.
   - WS: state stream (robot poses, order status, alarms) batched at 10Hz from snapshot()/adapter events.
   - Composition root: api process instantiates map + Vda5050Adapter + Orchestrator (config via env), OR FakeAdapter demo mode (`DEMO=1` — no broker needed).
2. **Persistence (Postgres)** — spec tables: robots, transport_orders + history, missions, state_snapshots (JSONB raw VDA state, retention), kpi_snapshots. NOTE: machine has NO docker — for local dev use `pglite` (@electric-sql/pglite, Apache-2.0, in-process WASM Postgres) or plain better-sqlite3 fallback behind a thin repository interface; real Postgres via connection string in prod. Decide in brainstorm, document. Persistence must be optional (api runs stateless-in-memory without DB — demo mode).
3. **@tez/dashboard** — React 18 + TS + Vite; PixiJS v8 + pixi-viewport live map (imperative sprite updates from zustand store, rAF-batched — 60fps at 50 robots; NOT Konva); shadcn/ui + Recharts for task queue, robot cards (battery/state/errors), KPI row, alarm list; RU/UZ/EN i18n (carry keys/tone from orchestrator-demo/src/i18n.ts). Design quality matters (PTA video) — mine rmf-web (Apache-2.0, github.com/open-rmf/rmf-web) for layout patterns; brand: cobalt #4F46E5, IBM Plex Sans + JetBrains Mono (see site tokens in the PTA package repo folder and orchestrator-demo styles).
4. **Demo scenario script** — `packages/api` or sim addition: one command boots demo mode (FakeAdapter or sim fleet + aedes broker) + api + dashboard dev server, seeded order flow, for screen recording. Target: `corepack pnpm demo` at repo root.

## Environment facts (do not rediscover)

- NO container runtime on this Mac; brew install blocked. No real Postgres/Mosquitto locally — hence pglite/sqlite option and the in-repo aedes dev broker (`startDevBroker({port:0,wsPort:0})` from @tez/robot-interface; ephemeral ports mandatory in tests, cross-process race).
- pnpm ONLY via `corepack pnpm`. `.npmrc workspace-concurrency=1` stays. Full `pnpm -r test` ~10 min (sim soak) — filter to your packages during dev.
- All existing tests (149) and tsc --noEmit must stay green. ESM, strict TS, `.js` import extensions, vitest.
- License gate: MIT/Apache/BSD/EPL/ISC only. Grafana embed = AGPL forbidden. Check every new dep.
- Known quirks: orchestrator wall-clock mode has documented collision/throughput limits until the parallel fix lands (see BACKLOG P0) — for demo recordings use FakeAdapter lockstep mode or curated layouts (see packages/orchestrator/test/vda5050-integration.test.ts for a proven clean 3-robot layout).
- OrderBook semantics: assign() only robotId setter; byRobot active-only; requeue clears robotId.

## Process

Superpowers flow: brainstorming (short — scope above is pre-decided, resolve only persistence choice + dashboard IA) → writing-plans → subagent-driven-development (fresh implementer per task, adversarial review per task, ledger in .superpowers/sdd/). Fresh branch off main in a worktree under `.worktrees/` (gitignored). Conventional commits. Do NOT push to the public remote without owner approval. Design-quality pass on the dashboard before calling it done (it will be filmed).
