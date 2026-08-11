# Plan 2: API + Persistence + Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** REST/WS API + optional pglite/Postgres persistence + PixiJS live dashboard around the existing Orchestrator, filmed for the President Tech Award video.

**Architecture:** Three NEW packages — `@tez/persistence` (repository layer over a SqlDriver seam: pglite locally, pg in prod), `@tez/api` (Fastify composition root wrapping one Orchestrator; REST + 10Hz WS state stream driven by `snapshot()` polling), `@tez/dashboard` (React 18 + Vite SPA; zustand store fed by WS; imperative Pixi v8 map). Existing packages are consumed via public exports only.

**Tech Stack:** Node 20, TypeScript strict ESM (`.js` import extensions), Fastify 5 + @fastify/websocket + @fastify/swagger, @sinclair/typebox, @electric-sql/pglite, pg, React 18, Vite, zustand, pixi.js v8 + pixi-viewport, tailwindcss + shadcn/ui-style components (vendored), recharts, vitest.

**Spec:** `docs/specs/2026-08-11-plan2-api-dashboard-design.md` (this branch). System spec: `docs/specs/2026-08-10-orchestrator-design.md`.

## Global Constraints

- **HARD RULE — do NOT edit ANY existing package source.** A parallel session owns `packages/orchestrator/src/orchestrator.ts`, `packages/core/src/router.ts`, `packages/sim/test/e2e.test.ts`; beyond those, this branch adds new packages/files only. Missing hooks → append to `docs/PLAN2-HOOK-REQUESTS.md` and work around.
- pnpm ONLY via `corepack pnpm`. `.npmrc workspace-concurrency=1` stays. Run tests filtered: `corepack pnpm --filter @tez/<pkg> test` (full `-r test` ~10 min — final gate only).
- All 149 existing tests + `tsc --noEmit` (per-package `corepack pnpm --filter @tez/<pkg> exec tsc --noEmit`) stay green.
- Licenses: MIT / Apache-2.0 / BSD / EPL / ISC only. Never GPL/AGPL (no Grafana embed, no bekirbostanci code).
- ESM everywhere, `"type": "module"`, vitest, strict TS. Copy `tsconfig.json` shape from `packages/orchestrator`.
- Ports in tests: ALWAYS ephemeral (`port: 0` / `listen({port: 0})`).
- Conventional commits. No push to remote.
- Demo/recording path uses FakeAdapter lockstep (wall-clock orchestrator mode has known P0 collision limits until the parallel fix lands).

## Existing public API (verified, do not rediscover)

```ts
// @tez/orchestrator
new Orchestrator(map: WarehouseMap, adapter: RobotAdapter, opts?: OrchestratorOpts)
// opts: { tickMs?: number /*default 500*/, horizon?, offlineGraceMs?, now?: () => number }
orchestrator.start(): Promise<void>   // wall-clock interval mode
orchestrator.stop(): Promise<void>
orchestrator.tickOnce(): void         // manual tick (lockstep/demo/test)
orchestrator.submitOrder(pickupNode: string, dropNode: string): TransportOrder
orchestrator.snapshot(): { robots: RobotState[]; orders: TransportOrder[];
  kpis: { ordersPerHour: number; avgCycleMs: number; utilization: number } }
orchestrator.getAlarms(): string[]
// NO cancel-order API exists (hook request, see Task 3).

// @tez/core
WarehouseMap.fromJSON(json: unknown): WarehouseMap   // json = { nodes: MapNode[], edges: {from,to,bidirectional?}[] }
WarehouseMap.grid(width: number, height: number): RawMapData  // node ids "n{x}_{y}"
map.node(id: string): MapNode  // { id, pos: {x,y}, ... }
type TransportOrder = { id: string; pickupNode: string; dropNode: string;
  status: OrderStatus; robotId?: string; retries: number; createdAt: string;
  history: HistoryEntry[] }
type OrderStatus = "queued" | "dispatched" | "underway" | "completed" | "failed" | "canceled"

// @tez/shared
type RobotState = { id: string; pos: {x:number;y:number}; theta: number;
  battery: number; status: "IDLE"|"EXECUTING"|"CHARGING"|"ERROR"|"UNKNOWN";
  currentMissionId?: string; lastSeen: string }

// @tez/robot-interface
new FakeAdapter(initialRobots: Array<{id: string; startNodeId: string}>, map: WarehouseMap)
fakeAdapter.tick(): void   // advances robots one node; lockstep partner of tickOnce()
new Vda5050Adapter(agvIds: Array<{manufacturer: string; serialNumber: string}>,
  mqttUrl: string, opts?: { interfaceName?: string; vdaVersion?: "2.0.0" })
startDevBroker(opts?: {port?: number; wsPort?: number}): Promise<{
  port: number; wsPort: number; url: string; wsUrl: string; close(): Promise<void> }>

// Proven clean demo layout (from packages/orchestrator/test/vda5050-integration.test.ts):
// WarehouseMap.fromJSON(WarehouseMap.grid(8, 8)), robots at "n1_1", "n6_1", "n1_6".
```

---

## Milestone 1 — @tez/api skeleton + DEMO mode

### Task 1: @tez/api scaffold + typed env config

**Files:**
- Create: `packages/api/package.json`, `packages/api/tsconfig.json`, `packages/api/vitest.config.ts`, `packages/api/src/index.ts`, `packages/api/src/config.ts`
- Test: `packages/api/test/config.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `loadConfig(env: NodeJS.ProcessEnv): ApiConfig` where
  ```ts
  interface ApiConfig {
    mode: "demo" | "vda";            // DEMO=1 → demo
    port: number;                     // PORT, default 8080
    tickMs: number;                   // TICK_MS, default 500
    mqttUrl?: string;                 // MQTT_URL (vda mode; required unless devBroker)
    devBroker: boolean;               // DEV_BROKER=1
    databaseUrl?: string;             // DATABASE_URL (prod pg)
    pgliteDir?: string;               // PGLITE_DIR ("memory" allowed)
    mapFile?: string;                 // MAP_FILE
    robots: number;                   // ROBOTS, default 3 (demo fleet size)
  }
  ```

- [ ] **Step 1: Scaffold package.** `package.json` (`"name": "@tez/api"`, `"type": "module"`, deps: `fastify`, `@fastify/websocket`, `@fastify/swagger`, `@sinclair/typebox`, workspace deps `@tez/core`, `@tez/orchestrator`, `@tez/robot-interface`, `@tez/shared`; devDeps `vitest`, `typescript`, `ws` + `@types/ws`). Copy `tsconfig.json` + `vitest.config.ts` shape from `packages/orchestrator`. `src/index.ts` = `export { loadConfig } from "./config.js";` Run `corepack pnpm install`.
- [ ] **Step 2: Write failing test** `test/config.test.ts`:
  ```ts
  import { describe, it, expect } from "vitest";
  import { loadConfig } from "../src/config.js";

  describe("loadConfig", () => {
    it("defaults to vda mode on empty env", () => {
      const c = loadConfig({});
      expect(c.mode).toBe("vda");
      expect(c.port).toBe(8080);
      expect(c.tickMs).toBe(500);
      expect(c.robots).toBe(3);
    });
    it("DEMO=1 switches mode", () => {
      expect(loadConfig({ DEMO: "1" }).mode).toBe("demo");
    });
    it("parses numbers and rejects garbage", () => {
      expect(loadConfig({ PORT: "9000" }).port).toBe(9000);
      expect(() => loadConfig({ PORT: "abc" })).toThrow(/PORT/);
    });
    it("vda mode without MQTT_URL and without DEV_BROKER throws", () => {
      expect(() => loadConfig({ DEMO: "0" })).toThrow(/MQTT_URL/);
      expect(loadConfig({ DEV_BROKER: "1" }).devBroker).toBe(true);
    });
  });
  ```
- [ ] **Step 3: Run to verify fail:** `corepack pnpm --filter @tez/api test` → FAIL (config.js missing).
- [ ] **Step 4: Implement `src/config.ts`** — plain parsing, `intEnv(env, name, fallback)` helper that throws `new Error(\`\${name} must be an integer\`)` on garbage; the vda-mode validation rule from the test.
- [ ] **Step 5: Run tests → PASS. Also `corepack pnpm --filter @tez/api exec tsc --noEmit`.**
- [ ] **Step 6: Commit** `feat(api): package scaffold + typed env config`

### Task 2: composition root — buildSystem (demo + vda modes)

**Files:**
- Create: `packages/api/src/system.ts`, `packages/api/src/demo-map.ts`
- Test: `packages/api/test/system.test.ts`

**Interfaces:**
- Consumes: `loadConfig`/`ApiConfig` (Task 1); existing `Orchestrator`, `FakeAdapter`, `Vda5050Adapter`, `startDevBroker`, `WarehouseMap`.
- Produces:
  ```ts
  interface System {
    orchestrator: Orchestrator;
    map: WarehouseMap;
    mapJson: unknown;                    // raw {nodes,edges} served by GET /map
    mode: "demo" | "vda";
    start(): Promise<void>;              // demo: lockstep interval (adapter.tick() then tickOnce()); vda: orchestrator.start()
    stop(): Promise<void>;               // clears interval / stops orchestrator + closes dev broker
  }
  buildSystem(config: ApiConfig): Promise<System>
  DEMO_MAP: unknown                      // demo-map.ts: WarehouseMap.grid(8,8) raw data
  DEMO_START_NODES: string[]             // ["n1_1","n6_1","n1_6", ...extended deterministically for robots>3]
  ```
- Demo mode MUST NOT call `orchestrator.start()` (wall-clock mode has known P0 limits): `start()` runs `setInterval(() => { fake.tick(); orchestrator.tickOnce(); }, config.tickMs)`.
- vda mode: `Vda5050Adapter` with agvIds `{manufacturer: "tez", serialNumber: "r{i}"}`, url = `config.mqttUrl` or dev broker's `url` when `config.devBroker`; then `orchestrator.start()`.
- `MAP_FILE` set → `JSON.parse(readFileSync)` it; else `DEMO_MAP`.

- [ ] **Step 1: Write failing test** `test/system.test.ts` (demo mode only — vda path is compile-checked here, exercised in Task 12's demo:vda run):
  ```ts
  import { describe, it, expect } from "vitest";
  import { buildSystem } from "../src/system.js";
  import { loadConfig } from "../src/config.js";

  describe("buildSystem demo mode", () => {
    it("boots FakeAdapter fleet and completes an order via lockstep interval", async () => {
      const sys = await buildSystem(loadConfig({ DEMO: "1", TICK_MS: "10" }));
      await sys.start();
      try {
        const order = sys.orchestrator.submitOrder("n2_2", "n5_5");
        expect(order.status).toBe("queued");
        await new Promise((r) => setTimeout(r, 1500));
        const snap = sys.orchestrator.snapshot();
        const done = snap.orders.find((o) => o.id === order.id);
        expect(done?.status).toBe("completed");
        expect(snap.robots).toHaveLength(3);
      } finally {
        await sys.stop();
      }
    });
  });
  ```
- [ ] **Step 2: Run → FAIL** (system.js missing).
- [ ] **Step 3: Implement `demo-map.ts` + `system.ts`** per Produces block. `DEMO_START_NODES` beyond 3 robots: fill deterministically from grid corners/edges avoiding duplicates (`n6_6`, `n3_1`, `n1_3`, ...).
- [ ] **Step 4: Run → PASS** (tune timeout only if flaky; lockstep at 10ms completes an 8x8 order well under 1.5s).
- [ ] **Step 5: Commit** `feat(api): composition root — demo lockstep + vda wiring`

### Task 3: REST — orders, robots, health (+ hook-request doc)

**Files:**
- Create: `packages/api/src/server.ts`, `packages/api/src/routes/orders.ts`, `packages/api/src/routes/robots.ts`, `packages/api/src/routes/health.ts`, `docs/PLAN2-HOOK-REQUESTS.md`
- Test: `packages/api/test/rest.test.ts`

**Interfaces:**
- Consumes: `System`/`buildSystem` (Task 2).
- Produces: `buildServer(system: System, opts?: { persistence?: Persistence }): Promise<FastifyInstance>` (persistence param unused until Task 8 — declare now as optional `unknown`-typed placeholder named `persistence?: object`). Routes:
  - `POST /orders` body `{pickupNode: string, dropNode: string}` → 201 `TransportOrder`; unknown node → 400.
  - `GET /orders` → `{orders: TransportOrder[]}` from `snapshot()`.
  - `DELETE /orders/:id` → **501** `{error: "cancel not supported: orchestrator exposes no cancel API (see docs/PLAN2-HOOK-REQUESTS.md)"}`.
  - `GET /robots` → `{robots: RobotState[]}`.
  - `GET /health` → `{status: "ok", mode, robotsOnline: number, degraded: false}`.
  All request/response schemas via Typebox (`Type.Object(...)`) attached to route `schema` — that feeds OpenAPI later.
- Also creates `docs/PLAN2-HOOK-REQUESTS.md` with entry 1: cancelOrder(orderId) public method needed on Orchestrator (OrderBook is private); v1 workaround = 501.

- [ ] **Step 1: Write failing test** `test/rest.test.ts` using `fastify.inject` (no port):
  ```ts
  import { describe, it, expect, beforeAll, afterAll } from "vitest";
  import { buildSystem } from "../src/system.js";
  import { buildServer } from "../src/server.js";
  import { loadConfig } from "../src/config.js";
  import type { FastifyInstance } from "fastify";

  let app: FastifyInstance;
  let stop: () => Promise<void>;
  beforeAll(async () => {
    const sys = await buildSystem(loadConfig({ DEMO: "1", TICK_MS: "10" }));
    await sys.start();
    stop = () => sys.stop();
    app = await buildServer(sys);
  });
  afterAll(async () => { await app.close(); await stop(); });

  describe("REST", () => {
    it("POST /orders creates queued order", async () => {
      const res = await app.inject({ method: "POST", url: "/orders",
        payload: { pickupNode: "n2_2", dropNode: "n5_5" } });
      expect(res.statusCode).toBe(201);
      expect(res.json().status).toBe("queued");
    });
    it("POST /orders rejects unknown node", async () => {
      const res = await app.inject({ method: "POST", url: "/orders",
        payload: { pickupNode: "nope", dropNode: "n5_5" } });
      expect(res.statusCode).toBe(400);
    });
    it("POST /orders rejects missing body field", async () => {
      const res = await app.inject({ method: "POST", url: "/orders", payload: { pickupNode: "n2_2" } });
      expect(res.statusCode).toBe(400);
    });
    it("GET /orders lists", async () => {
      const res = await app.inject({ method: "GET", url: "/orders" });
      expect(res.json().orders.length).toBeGreaterThan(0);
    });
    it("DELETE /orders/:id returns 501", async () => {
      const res = await app.inject({ method: "DELETE", url: "/orders/ord-00001" });
      expect(res.statusCode).toBe(501);
    });
    it("GET /robots returns fleet", async () => {
      const res = await app.inject({ method: "GET", url: "/robots" });
      expect(res.json().robots).toHaveLength(3);
    });
    it("GET /health ok", async () => {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.json().status).toBe("ok");
    });
  });
  ```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `server.ts` (fastify factory, registers route plugins) + three route files. Unknown-node check: `system.map.node(id)` throws → catch → 400. Write `docs/PLAN2-HOOK-REQUESTS.md`.
- [ ] **Step 4: Run → PASS. tsc clean.**
- [ ] **Step 5: Commit** `feat(api): REST orders/robots/health + hook-request doc`

### Task 4: WS /ws/state — 10Hz batched stream

**Files:**
- Create: `packages/api/src/ws.ts`
- Modify: `packages/api/src/server.ts` (register plugin)
- Test: `packages/api/test/ws.test.ts`

**Interfaces:**
- Consumes: `System` (Task 2), `buildServer` (Task 3).
- Produces: WS endpoint `GET /ws/state` streaming JSON frames every `max(100, 1000/10)`ms (10Hz, `WS_HZ` env honored later — hardcode 100ms interval constant `FRAME_MS = 100`):
  ```ts
  interface StateFrame {
    t: string;            // ISO timestamp
    seq: number;          // per-connection increasing
    degraded: boolean;    // false in v1 (broker-down flag wired in vda mode when adapter reports no robots online)
    robots: RobotState[];
    orders: TransportOrder[];
    kpis: { ordersPerHour: number; avgCycleMs: number; utilization: number };
    alarms: string[];     // tail: last 100 of orchestrator.getAlarms()
  }
  ```
  Full frame on connect (seq=0) then every tick. One shared `setInterval` per server (not per socket); broadcast to all sockets; interval unref'd and cleared on `app.close()` via `onClose` hook.
- Frame assembly = pure function `makeFrame(system: System, seq: number): StateFrame` (exported for reuse/testing).

- [ ] **Step 1: Write failing test** `test/ws.test.ts` — real socket, ephemeral port:
  ```ts
  import { describe, it, expect } from "vitest";
  import WebSocket from "ws";
  import { buildSystem } from "../src/system.js";
  import { buildServer } from "../src/server.js";
  import { loadConfig } from "../src/config.js";

  describe("WS /ws/state", () => {
    it("streams frames with robots and increasing seq", async () => {
      const sys = await buildSystem(loadConfig({ DEMO: "1", TICK_MS: "10" }));
      await sys.start();
      const app = await buildServer(sys);
      await app.listen({ port: 0, host: "127.0.0.1" });
      const port = (app.server.address() as { port: number }).port;
      try {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/state`);
        const frames: any[] = [];
        await new Promise<void>((resolve, reject) => {
          ws.on("message", (d) => {
            frames.push(JSON.parse(d.toString()));
            if (frames.length >= 3) { ws.close(); resolve(); }
          });
          ws.on("error", reject);
        });
        expect(frames[0].robots).toHaveLength(3);
        expect(frames[2].seq).toBeGreaterThan(frames[0].seq);
        expect(frames[0]).toHaveProperty("kpis.utilization");
      } finally {
        await app.close(); await sys.stop();
      }
    });
  });
  ```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `ws.ts`** (register `@fastify/websocket`, route handler adds socket to a Set, shared interval broadcasts `makeFrame`, cleanup on close/error + `onClose`).
- [ ] **Step 4: Run → PASS. tsc clean.**
- [ ] **Step 5: Commit** `feat(api): 10Hz WS state stream`

### Task 5: map + kpi endpoints, OpenAPI, main entrypoint

**Files:**
- Create: `packages/api/src/routes/map.ts`, `packages/api/src/routes/kpi.ts`, `packages/api/src/main.ts`
- Modify: `packages/api/src/server.ts` (swagger + new routes), `packages/api/package.json` (add `"start": "node dist/main.js"`; create `tsconfig.build.json` emitting `src/` → `dist/`, excluding tests — the Task 12 demo script builds via `corepack pnpm --filter @tez/api exec tsc -p tsconfig.build.json`)
- Test: `packages/api/test/map-kpi.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces:
  - `GET /map` → 200, the raw `{nodes, edges}` JSON (`system.mapJson`).
  - `PUT /map` body = raw map JSON → validate via `WarehouseMap.fromJSON` (throws → 400); write to `config.mapFile ?? "map.json"` (cwd); → 200 `{ok: true, restartRequired: true}` (runtime swap would need orchestrator rebuild — out of v1 scope, honest flag instead).
  - `GET /kpi` → `{live: snapshot().kpis}` (DB range param added in Task 8).
  - `GET /docs` serves OpenAPI UI via `@fastify/swagger` + `@fastify/swagger-ui` (both MIT).
  - `src/main.ts`: `loadConfig(process.env)` → `buildSystem` → `buildServer` → `listen({port, host: "0.0.0.0"})`; SIGINT/SIGTERM graceful stop.

- [ ] **Step 1: Write failing test** `test/map-kpi.test.ts` (inject; PUT writes to a temp file — set `MAP_FILE` to a path under `os.tmpdir()` in the test's config; GET /map returns same shape it was booted with; invalid map body → 400; GET /kpi has `live.utilization`).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** Add `@fastify/swagger-ui` dep. `tsconfig.build.json` (`"outDir": "dist"`, `"rootDir": "src"`, excludes tests).
- [ ] **Step 4: Run → PASS. tsc clean. Verify OpenAPI route registers (inject GET /docs/json → 200).**
- [ ] **Step 5: Commit** `feat(api): map + kpi endpoints, OpenAPI docs, main entrypoint`

---

## Milestone 2 — @tez/persistence

### Task 6: @tez/persistence scaffold — SqlDriver seam + migrations + schema

**Files:**
- Create: `packages/persistence/package.json`, `packages/persistence/tsconfig.json`, `packages/persistence/vitest.config.ts`, `packages/persistence/src/index.ts`, `packages/persistence/src/driver.ts`, `packages/persistence/src/pglite-driver.ts`, `packages/persistence/src/pg-driver.ts`, `packages/persistence/src/migrate.ts`, `packages/persistence/src/migrations/001_init.sql` (imported as string via a `migrations.ts` registry — avoid fs-read-at-runtime path issues: `src/migrations.ts` exports `const MIGRATIONS: Array<{id: string; sql: string}>` with the SQL inline in template literals)
- Test: `packages/persistence/test/migrate.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (standalone package; deps `@electric-sql/pglite`, `pg` + `@types/pg`).
- Produces:
  ```ts
  interface SqlDriver {
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
    close(): Promise<void>;
  }
  createPgliteDriver(dataDir?: string): Promise<SqlDriver>   // undefined/"memory" → in-memory
  createPgDriver(databaseUrl: string): SqlDriver              // pg.Pool wrapper
  migrate(driver: SqlDriver): Promise<string[]>               // returns applied ids; tracks in schema_migrations
  MIGRATIONS: Array<{id: string; sql: string}>
  ```
- Schema (001_init): `robots(id text primary key, last_state jsonb not null, updated_at timestamptz not null)`; `transport_orders(id text primary key, pickup_node text, drop_node text, status text, robot_id text, retries int, created_at timestamptz, updated_at timestamptz)`; `transport_order_history(id bigserial primary key, order_id text not null, at timestamptz not null, status text not null, robot_id text, note text)`; `missions(id text primary key, order_id text, robot_id text, node_ids jsonb, created_at timestamptz)`; `state_snapshots(id bigserial primary key, at timestamptz not null, snapshot jsonb not null)`; `kpi_snapshots(id bigserial primary key, at timestamptz not null, orders_per_hour double precision, avg_cycle_ms double precision, utilization double precision)`; index `state_snapshots(at)`, `transport_order_history(order_id)`.

- [ ] **Step 1: Scaffold package** (same shapes as Task 1), `corepack pnpm install`.
- [ ] **Step 2: Write failing test** `test/migrate.test.ts`:
  ```ts
  import { describe, it, expect } from "vitest";
  import { createPgliteDriver } from "../src/pglite-driver.js";
  import { migrate } from "../src/migrate.js";

  describe("migrate on pglite", () => {
    it("applies all migrations once, idempotent", async () => {
      const db = await createPgliteDriver();
      const first = await migrate(db);
      expect(first).toContain("001_init");
      const second = await migrate(db);
      expect(second).toHaveLength(0);
      const r = await db.query("insert into kpi_snapshots(at, orders_per_hour, avg_cycle_ms, utilization) values (now(), 1, 2, 0.5) returning id");
      expect(r.rows[0].id).toBeDefined();
      await db.close();
    });
  });
  ```
- [ ] **Step 3: Run → FAIL. Implement drivers + migrate (create `schema_migrations(id text primary key, applied_at timestamptz)` if absent; apply missing in order inside a transaction each).** pglite: `new PGlite()` in-memory or `new PGlite(dataDir)`; its `.query(sql, params)` returns `{rows}` — adapt to `SqlDriver`. pg: `new pg.Pool({connectionString})`, `pool.query(sql, params)`.
- [ ] **Step 4: Run → PASS. tsc clean.** (PgDriver: type-checked; no live pg server locally — covered by identical SQL running on pglite.)
- [ ] **Step 5: Commit** `feat(persistence): SqlDriver seam (pglite/pg) + migration runner + schema`

### Task 7: repositories

**Files:**
- Create: `packages/persistence/src/repos.ts`
- Modify: `packages/persistence/src/index.ts` (export)
- Test: `packages/persistence/test/repos.test.ts`

**Interfaces:**
- Consumes: `SqlDriver`, `createPgliteDriver`, `migrate` (Task 6). Types `TransportOrder`, `RobotState` from `@tez/core`/`@tez/shared` (add workspace deps).
- Produces:
  ```ts
  createRepos(driver: SqlDriver): Repos
  interface Repos {
    orders: {
      upsert(o: TransportOrder): Promise<void>;                       // insert or update by id
      appendHistory(orderId: string, at: string, status: string, robotId?: string, note?: string): Promise<void>;
      list(opts?: {status?: string; limit?: number}): Promise<Array<Record<string, unknown>>>;
      history(orderId: string): Promise<Array<Record<string, unknown>>>;
    };
    robots: { upsert(r: RobotState): Promise<void>; list(): Promise<Array<Record<string, unknown>>> };
    snapshots: {
      insertState(at: string, snapshot: unknown): Promise<void>;
      insertKpi(at: string, k: {ordersPerHour: number; avgCycleMs: number; utilization: number}): Promise<void>;
      kpiRange(fromIso: string, toIso: string): Promise<Array<Record<string, unknown>>>;
      pruneStateOlderThan(iso: string): Promise<number>;              // returns deleted count
    };
  }
  ```

- [ ] **Step 1: Write failing test** — in-memory pglite + migrate in `beforeAll`; cover: order upsert twice (status change persists), history append + fetch ordered by at, robot upsert/list, kpi insert + range query returns inserted row, prune deletes old state rows only.
- [ ] **Step 2: Run → FAIL. Implement `repos.ts`** — plain parameterized SQL (`insert ... on conflict (id) do update set ...`), JSONB params passed as `JSON.stringify(...)::jsonb` or driver-native object (pglite accepts objects for jsonb — verify in test; if not, stringify).
- [ ] **Step 3: Run → PASS. tsc clean.**
- [ ] **Step 4: Commit** `feat(persistence): typed repositories over SqlDriver`

### Task 8: wire persistence into api

**Files:**
- Create: `packages/api/src/recorder.ts`
- Modify: `packages/api/src/main.ts` (build persistence when configured), `packages/api/src/server.ts` (accept `repos`), `packages/api/src/routes/orders.ts` (`GET /orders?history=1`), `packages/api/src/routes/kpi.ts` (`GET /kpi?from=&to=`), `packages/api/package.json` (dep `@tez/persistence`)
- Test: `packages/api/test/persistence-wiring.test.ts`

**Interfaces:**
- Consumes: `Repos`/`createRepos`/`createPgliteDriver`/`migrate` (Tasks 6–7), `System` (Task 2), `buildServer` (Task 3 — replace the placeholder `persistence?: object` param with `repos?: Repos`).
- Produces:
  ```ts
  startRecorder(system: System, repos: Repos, opts?: {snapshotEveryMs?: number /*default 5000*/}): { stop(): void }
  ```
  Recorder polls `snapshot()` each second: diffs order `status` against a local `Map<orderId, OrderStatus>`; on change → `orders.upsert` + `orders.appendHistory` (at = now ISO); robots upserted each snapshot interval; every `snapshotEveryMs` → `snapshots.insertState` + `insertKpi`. ALL writes `.catch(err => log.warn(...))` — never throw into the loop, never block requests.
  - `GET /orders?history=1` → each order gains `history` from DB (when repos present; without repos, the in-memory `TransportOrder.history` is already in the payload).
  - `GET /kpi?from=<iso>&to=<iso>` → `{live, range: [...]}` when repos present; `?from` without repos → `{live, range: null, note: "persistence disabled"}`.

- [ ] **Step 1: Write failing test** — demo system + in-memory pglite repos + recorder with 50ms snapshot interval; submit order, run ~1.5s lockstep, assert: `transport_order_history` has ≥2 rows for the order (queued→…→completed), `kpi_snapshots` non-empty, `GET /kpi?from=&to=` (inject) returns range rows, api still fully functional with NO repos (health 200).
- [ ] **Step 2: Run → FAIL. Implement.**
- [ ] **Step 3: Run → PASS. tsc clean for api + persistence.**
- [ ] **Step 4: Commit** `feat(api): optional persistence wiring — recorder + history/kpi range endpoints`

---

## Milestone 3 — @tez/dashboard core

### Task 9: dashboard scaffold + theme + i18n

**Files:**
- Create: `packages/dashboard/package.json`, `packages/dashboard/tsconfig.json`, `packages/dashboard/vite.config.ts`, `packages/dashboard/vitest.config.ts`, `packages/dashboard/index.html`, `packages/dashboard/src/main.tsx`, `packages/dashboard/src/App.tsx`, `packages/dashboard/src/theme.css`, `packages/dashboard/src/i18n.ts`
- Test: `packages/dashboard/test/i18n.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks. NOT a consumer of workspace runtime packages except types: dep `@tez/shared`, `@tez/core` (types only).
- Produces:
  - Vite React 18 TS app, `"dev": "vite", "build": "vite build"`. Vite proxy: `/ws` + `/orders` + `/robots` + `/map` + `/kpi` + `/health` → `http://localhost:8080` (env `VITE_API` override).
  - `src/i18n.ts`: `type Lang = "ru" | "uz" | "en"`; `const STRINGS: Record<Lang, Record<string, string>>` — carry ALL keys/tone from `orchestrator-demo/src/i18n.ts` (copy file, extend with new keys: `tabCockpit`, `tabOrders`, `tabAnalytics`, `alarms`, `connection`, `connected`, `reconnecting`, `orderId`, `status`, `robot`, `battery`, `queue`, `searchOrders`); `useI18n()` hook → `{lang, setLang, t: (k: string) => string}` (zustand-backed, persists lang to localStorage).
  - `theme.css`: dark default; CSS vars `--brand: #4F46E5`, surfaces near-black `#0B0E14`/`#131722`, text `#E6E9F0`; fonts IBM Plex Sans (UI) + JetBrains Mono (numbers/ids) via @fontsource packages (MIT) — deps `@fontsource/ibm-plex-sans`, `@fontsource/jetbrains-mono`.
  - Tailwind v4 (`@tailwindcss/vite`) wired; shadcn/ui NOT installed via CLI — small vendored `src/components/ui/` primitives written by hand as needed later (button, card, badge, drawer) in shadcn style.
  - `App.tsx`: header (logo text "Tez Robotics", lang switcher RU/UZ/EN, connection chip placeholder), tab bar Cockpit/Orders/Analytics (zustand `useUiStore` with `tab: "cockpit"|"orders"|"analytics"`), empty tab panels.
- deps: `react`, `react-dom`, `zustand`, devDeps `vite`, `@vitejs/plugin-react`, `vitest`, `happy-dom`, `@testing-library/react`.

- [ ] **Step 1: Scaffold + failing test** `test/i18n.test.ts`: all three langs have identical key sets; `t()` falls back to key when missing; setLang persists.
- [ ] **Step 2: Run → FAIL. Implement.**
- [ ] **Step 3: Run → PASS.** `corepack pnpm --filter @tez/dashboard exec tsc --noEmit` clean. `corepack pnpm --filter @tez/dashboard build` succeeds.
- [ ] **Step 4: Commit** `feat(dashboard): Vite scaffold, dark brand theme, RU/UZ/EN i18n, tab shell`

### Task 10: WS client + state store

**Files:**
- Create: `packages/dashboard/src/ws-client.ts`, `packages/dashboard/src/store.ts`
- Test: `packages/dashboard/test/store.test.ts`

**Interfaces:**
- Consumes: Task 9 scaffold. Frame shape = `StateFrame` from Task 4 (duplicate the type locally in `src/types.ts` — dashboard does not import server code; keep field-for-field identical).
- Produces:
  ```ts
  // store.ts (zustand vanilla store + React hook)
  interface FleetState {
    connection: "connecting" | "connected" | "reconnecting";
    frame?: StateFrame;                 // latest full frame
    lastFrameAt?: number;
    applyFrame(f: StateFrame): void;
    setConnection(c: FleetState["connection"]): void;
    selectedRobotId?: string;
    selectRobot(id?: string): void;
  }
  useFleetStore   // React hook
  fleetStore      // vanilla store (Pixi subscribes via fleetStore.subscribe)
  // ws-client.ts
  startWsClient(url: string, store: typeof fleetStore, opts?: {backoffMs?: number[]}): {stop(): void}
  // reconnect backoff default [500, 1000, 2000, 5000, 5000...]; sets connection states; JSON.parse each message → applyFrame
  ```

- [ ] **Step 1: Write failing test** `test/store.test.ts`: applyFrame updates frame + lastFrameAt; selectRobot toggles; ws-client against a local `ws` server (ephemeral port, devDep `ws`): receives frames → store updated; server close → connection "reconnecting" → server restart on same port → "connected" again (backoff [50,50] for test speed).
- [ ] **Step 2: Run → FAIL. Implement.**
- [ ] **Step 3: Run → PASS. tsc clean.**
- [ ] **Step 4: Commit** `feat(dashboard): WS client with backoff + zustand fleet store`

### Task 11: Pixi live map

**Files:**
- Create: `packages/dashboard/src/map/PixiMap.tsx`, `packages/dashboard/src/map/renderer.ts`, `packages/dashboard/src/map/coords.ts`
- Modify: `packages/dashboard/src/App.tsx` (mount in Cockpit tab)
- Test: `packages/dashboard/test/coords.test.ts`

**Interfaces:**
- Consumes: `fleetStore` (Task 10); `GET /map` fetch for static layer (raw `{nodes, edges}`).
- Produces:
  - `coords.ts`: `const CELL = 48; gridToPx(pos: {x,y}): {x,y}` (y-down, `pos * CELL`), pure + tested.
  - `renderer.ts`: `createRenderer(app: Pixi.Application, mapJson: RawMapLike): Renderer` with `Renderer.update(frame: StateFrame, selectedRobotId?: string)` — imperative: static layer (node dots, edge lines, subtle grid) drawn once to a `Graphics`; per-robot `Container` (rounded-rect body in brand cobalt, heading tick from `theta`, id label JetBrains Mono, battery arc, status ring color: IDLE gray / EXECUTING cobalt / CHARGING green / ERROR red / UNKNOWN amber); robot containers positioned each update with short lerp toward target px (rAF handled by Pixi ticker — set position targets in `update`, lerp in ticker callback); selection = brighter ring + soft glow.
  - `PixiMap.tsx`: creates `Pixi.Application` (v8 async `init`), `pixi-viewport` (drag/pinch/wheel zoom, clamp), subscribes `fleetStore.subscribe` (NOT React state — zero re-render per frame), click on robot container → `selectRobot(id)`, resize observer. Dep: `pixi.js@^8`, `pixi-viewport@^6` (check pixi-viewport peer supports v8; if npm peer conflict, use `pixi-viewport@6.x` which targets v8 — verify at install and note the resolved version in the task report).
- [ ] **Step 1: Write failing test** for `coords.ts` (gridToPx mapping, CELL export). Pixi/DOM layer excluded from vitest (`test.exclude` pattern or plain no-test — DOM/GPU not testable in happy-dom).
- [ ] **Step 2: Run → FAIL. Implement coords → PASS.**
- [ ] **Step 3: Implement renderer + PixiMap + mount.** Manual verify (Task 12 gives the runnable stack; here: `corepack pnpm --filter @tez/dashboard build` + tsc clean is the gate).
- [ ] **Step 4: Commit** `feat(dashboard): Pixi v8 live map — viewport, robot sprites, selection`

### Task 12: cockpit chrome + demo script (first filmable build)

**Files:**
- Create: `packages/dashboard/src/components/RobotCard.tsx`, `packages/dashboard/src/components/TaskQueue.tsx`, `packages/dashboard/src/components/KpiRow.tsx`, `packages/dashboard/src/components/AlarmDrawer.tsx`, `packages/dashboard/src/components/ui/` (card, badge, button, drawer primitives), `scripts/demo.mjs`
- Modify: `packages/dashboard/src/App.tsx` (cockpit layout), root `package.json` (`"demo"` script)
- Test: `packages/dashboard/test/components.test.tsx`

**Interfaces:**
- Consumes: `useFleetStore` (Task 10), `useI18n` (Task 9), api REST (`POST /orders` from TaskQueue's "add demo order" button — dev nicety, also used on camera).
- Produces:
  - Cockpit layout: CSS grid — map center (`1fr`), right rail 320px scrollable `RobotCard` list (battery bar, status badge, current order id, error text; click card ⇄ map selection sync), bottom strip: `TaskQueue` (queued/underway orders as compact rows, status badge colors matching robot ring colors, "+ order" button posting random valid pickup/drop) + `KpiRow` (orders/h, avg cycle s, utilization %, queue depth — JetBrains Mono big numerals). Header alarm badge (count) → `AlarmDrawer` slide-over listing alarm strings, newest first.
  - `scripts/demo.mjs` (root, plain JS — Node 20 cannot strip TS types): builds api (`corepack pnpm --filter @tez/api exec tsc -p tsconfig.build.json`), spawns `node packages/api/dist/main.js` with `DEMO=1 PGLITE_DIR=memory PORT=8080`, waits for `/health` 200, spawns `corepack pnpm --filter @tez/dashboard dev` (port 5173), then seeds: 6 orders POSTed at 4s stagger from a curated pair list on the 8x8 demo map, prints `http://localhost:5173`. SIGINT kills both children.
  - Root `package.json`: `"demo": "node scripts/demo.mjs"`, `"demo:vda": "node scripts/demo.mjs --vda"`.
  - `--vda` variant: api spawned with `DEV_BROKER=1` instead of `DEMO=1`; `main.ts` (Task 5) logs a parseable line `BROKER_URL=<url>` when it starts the dev broker; demo script waits for that line, writes the demo map to a temp file, then spawns a sim-fleet child: `node --input-type=module -e "import {spawnFleet} from '@tez/sim'; ..."` with `{mapPath, robots: 3, mqttUrl}` (cwd = repo root so workspace resolution works; requires `corepack pnpm --filter @tez/sim exec tsc -p tsconfig.build.json`-style build only if @tez/sim has no dist — check and reuse whatever build the sim package already has; if bare-node dist is still broken (BACKLOG P1), keep `demo:vda` best-effort and note it in the task report — `demo` (FakeAdapter) is the filming path and must work regardless).
- [ ] **Step 1: Write failing component tests** (happy-dom + testing-library): RobotCard renders battery %/status badge from a fixture RobotState; TaskQueue renders orders sorted queued-first; KpiRow formats `avgCycleMs`→seconds 1 decimal; AlarmDrawer opens on badge click and lists alarms newest-first.
- [ ] **Step 2: Run → FAIL. Implement components + layout.**
- [ ] **Step 3: Run → PASS. tsc + build clean.**
- [ ] **Step 4: Manual end-to-end:** `corepack pnpm demo` — verify in browser: robots move smoothly, order flow completes, cards/queue/KPI live, alarms drawer, lang switch, selection sync. Fix what's broken (this step IS the Pixi verification gate).
- [ ] **Step 5: Commit** `feat(dashboard): cockpit chrome + one-command demo (pnpm demo)`

---

## Milestone 4 — tabs + polish + gate

### Task 13: Orders + Analytics tabs

**Files:**
- Create: `packages/dashboard/src/tabs/OrdersTab.tsx`, `packages/dashboard/src/tabs/AnalyticsTab.tsx`
- Modify: `packages/dashboard/src/App.tsx`
- Test: `packages/dashboard/test/tabs.test.tsx`

**Interfaces:**
- Consumes: store frame (live orders), REST `GET /orders?history=1`, `GET /kpi?from=&to=` (Task 8 shapes). Dep: `recharts`.
- Produces:
  - OrdersTab: table (id mono, pickup→drop, status badge, robot, retries, createdAt local time), client-side status filter chips + text search on id; row expand → history timeline (fetched once per expand from `?history=1` payload; when persistence off, in-memory history from frame).
  - AnalyticsTab: three Recharts `AreaChart`s (orders/h, utilization %, avg cycle s) over `kpi_snapshots` range (last hour, refetch every 30s); when `range: null` (no DB) → live-only sparkline built client-side from a rolling buffer of frames (store gains `kpiBuffer: Array<{t: number; kpis: StateFrame["kpis"]}>` capped 600, appended in `applyFrame`).
- [ ] **Step 1: Failing tests:** OrdersTab filters by status chip + search; kpiBuffer caps at 600 and appends on applyFrame; AnalyticsTab renders 3 chart titles.
- [ ] **Step 2: Run → FAIL. Implement.**
- [ ] **Step 3: Run → PASS. tsc + build clean.**
- [ ] **Step 4: Commit** `feat(dashboard): orders history tab + analytics KPI trends`

### Task 14: design-quality pass + full-repo gate

**Files:**
- Modify: dashboard styles/components as the pass dictates; `README.md` (add demo instructions section); `docs/BACKLOG.md` (append any deferred items found)
- Test: existing suites.

**Interfaces:** consumes everything; produces the filmable build.

- [ ] **Step 1: Run `corepack pnpm demo`, screenshot-review the cockpit** against: visual hierarchy (map dominant, chrome recedes), consistent spacing scale, status color coherence map⇄cards⇄queue, typography (Plex/JetBrains, no default-font leaks), dark-theme contrast, all three langs render without overflow. Mine rmf-web layouts for comparison. Fix issues.
- [ ] **Step 2: Full gate:** `corepack pnpm -r test` (expect ~10 min; ALL suites green incl. 149 pre-existing) + `corepack pnpm -r exec tsc --noEmit`.
- [ ] **Step 3: License audit:** `corepack pnpm licenses list --prod` — verify every new dep MIT/Apache-2.0/BSD/ISC; record output summary in task report.
- [ ] **Step 4: README demo section + BACKLOG deferrals. Commit** `docs: demo instructions + plan2 deferrals`
- [ ] **Step 5: Rebase readiness check:** `git fetch . main` — confirm no overlap with fix-session files (`git diff --name-only main...HEAD` contains ONLY new package paths + docs). Report done; push = owner decision.
