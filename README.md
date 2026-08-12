# Tez Robotics

**Warehouse robotics for Uzbekistan & Central Asia** — AMR fleet integration plus our own orchestration platform with native 1C/WMS integration.

> Uzbekistan has zero local warehouse-robotics integrators. When the country's largest marketplace robotized its warehouse, the contractor had to come from abroad. Tez Robotics is building the local layer: deployment, orchestration software, and 24/7 on-site service.

## What's in this repository

| Module | Status | Description |
|---|---|---|
| [`packages/`](packages/) | ✅ v1 core, tested | **Tez Orchestrator** — production-grade fleet orchestration platform: VDA 5050 over MQTT, multi-robot routing (PIBT), cell-reservation traffic safety, Hungarian dispatch, order lifecycle with retry/failure recovery, simulated fleet speaking the real protocol |
| [`orchestrator-demo/`](orchestrator-demo/) | ✅ browser demo | Visual warehouse simulation: task allocation, routing, conflict resolution, live KPI dashboard (RU/UZ/EN) |
| `safety-cv/` | in development | Computer-vision safety module on existing CCTV: PPE compliance, hazard zones, forklift–pedestrian proximity |
| `1c-connector/` | planned | Native 1C integration layer — order intake and inventory sync for the orchestrator |

## Tez Orchestrator (`packages/`)

TypeScript monorepo implementing the real orchestration layer — robots connect as external clients over **VDA 5050 2.0 / MQTT**, so a physical AMR plugs in with zero core changes. Package map (`packages/`):

- **`@tez/shared`** — types and constants shared across every package (`RobotId`, `RobotState`, `CellKey`, `DEFAULT_MAP_ID`)
- **`@tez/core`** — warehouse map graph, PIBT multi-robot router (scales to 1000+ agents, deadlock-resolving), cell-reservation table, Hungarian assignment dispatcher, transport-order state machine
- **`@tez/robot-interface`** — protocol-agnostic adapter seam + real VDA 5050 adapter (built on the MIT-licensed Siemens `vda-5050-lib`); adapter architecture ready for vendor-specific protocols
- **`@tez/orchestrator`** — the control loop: dispatch → route → reserve → execute, offline-robot recovery, quarantine, live KPIs
- **`@tez/persistence`** — Postgres (and in-memory pglite) driver, migrations, and repos backing order/KPI history
- **`@tez/api`** — Fastify REST + WebSocket API fronting the orchestrator (demo `FakeAdapter` mode or real VDA 5050 mode)
- **`@tez/sim`** — simulated AMR fleet speaking real VDA 5050 over a real broker, failure-injection end-to-end soak tests
- **`@tez/dashboard`** — React/PixiJS live fleet cockpit (RU/UZ/EN), consumes the api's WS stream

280 tests (279 passing, 1 skipped) across the 8 `packages/*` workspaces, including multi-minute fleet soaks with robot-failure injection. Known v1 limits are documented in [`docs/BACKLOG.md`](docs/BACKLOG.md).

```bash
corepack pnpm install
corepack pnpm -r test        # full suite incl. e2e soak (~10 min, serialized)
```

Full production build is two steps, in order — the dashboard's Vite production build resolves `@tez/core`/`@tez/shared` via their built `dist/`, not source, so it needs them built first:

```bash
corepack pnpm build                              # 7 node packages (dashboard excluded)
corepack pnpm --filter @tez/dashboard build       # dashboard prod build, needs core/shared dist above
```

## Browser demo (`orchestrator-demo/`)

```bash
cd orchestrator-demo
npm install
npm run dev
```

## Live demo: API + dashboard (`packages/api`, `packages/dashboard`)

One command boots the real orchestrator behind a Fastify API, streaming live fleet state to a React/Pixi cockpit dashboard:

```bash
corepack pnpm install
corepack pnpm demo

# filming configuration: 20x10 floor, 8 robots, continuous order stream
corepack pnpm demo:film
```

This builds `@tez/api`, starts it in `DEMO` mode (an in-memory `FakeAdapter` fleet — no MQTT broker or physical robots needed), starts the dashboard's Vite dev server, and seeds a handful of demo orders on a stagger:

- **Dashboard:** http://localhost:5173
- **API:** http://localhost:8080 (`/health`, `/map`, `/orders`, `/kpi`, `/ws/state`, `/docs` for OpenAPI)

Persisted order/KPI history uses an in-memory pglite instance by default. Env vars:

- `PGLITE_DIR` — set to a filesystem path to persist history across restarts instead of the `"memory"` default
- `DEMO` / `PORT` / `TICK_MS` / `ROBOTS` — forwarded to the api; `pnpm demo` sets sane demo defaults itself, override by exporting before running

`Ctrl-C` tears down both the api and dashboard processes.

### `pnpm demo:vda` (best-effort)

```bash
corepack pnpm demo:vda
```

Same dashboard, but the api runs in real VDA 5050 mode against a local dev MQTT broker, with a 3-robot simulated fleet (`@tez/sim`) speaking the actual protocol instead of `FakeAdapter`. This path is **best-effort**: it depends on a dev MQTT broker and a simulated fleet process that can fail to start independently of the api/dashboard (see [`docs/BACKLOG.md`](docs/BACKLOG.md) for the known gaps). If the sim fleet fails to spawn, the api and dashboard still come up; you'll just see an empty fleet until robots connect. Note: in `vda` mode the simulated fleet's ids (`sim-00N`) don't yet match the api's configured AGV serials (`r1..r3`), so connected sim robots are currently ignored as unconfigured AGVs — tracked in [`docs/BACKLOG.md`](docs/BACKLOG.md).

## Why robots + local software

- Uzbekistan's e-commerce and distribution are growing fast; warehouses still run on foot while the workforce emigrates
- Global AMR vendors' fleet software has no 1C integration — the de-facto accounting standard of the region — and no localization
- Service contracts require presence: a fly-in foreign integrator cannot reach a Tashkent warehouse in an hour

**Model:** regional integration partner of global AMR vendors + our own orchestration and safety software + local 24/7 service.

## Team

- **Avazbek Abdusaidov** — founder. Logistics (Inha University), 3 years of hardware import operations from China (Tez Motors), AI engineer with 3 products in production.

---

*Tez Robotics · Tashkent, Uzbekistan · 2026*
