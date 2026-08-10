# Tez Orchestrator Core Implementation Plan (Plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Headless fleet orchestration core: transport orders dispatched to N simulated VDA 5050 robots over real MQTT, routed collision-free by windowed PIBT with cell reservations.

**Architecture:** pnpm monorepo, modular monolith. `core` (domain + dispatcher + router + traffic) is protocol-blind; `robot-interface` adapts core Missions to VDA 5050 via coaty `vda-5050-lib` MasterController; `sim` runs N VirtualAgvAdapter instances as a separate process against Mosquitto. Spec: `docs/specs/2026-08-10-orchestrator-design.md`.

**Tech Stack:** Node 20, TypeScript 5 (strict), pnpm workspaces, vitest, `vda-5050-lib` (MIT), Mosquitto 2 (Docker), munkres-js (vendored), ajv.

## Global Constraints

- License gate: dependencies MIT/Apache/BSD/EPL only. NEVER copy code from RHCR/EECBS/MAPF-LNS/PBS (research license), GPL tools, or unlicensed repos (Gitee AgvDispatchSystem, bekirbostanci rust sim).
- VDA 5050: wire-compat 2.0, types 2.1. Validate inbound/outbound at MQTT boundary with ajv against vendored official schemas (tag 2.1.0).
- Core packages must not import `vda-5050-lib` types — only `robot-interface` may.
- All timestamps ISO 8601 UTC. Coordinates: meters, map frame. Cells: integer grid keys `"x:y"`.
- Node ESM (`"type": "module"`), vitest for tests, no jest.
- Commit after every green test cycle. Conventional commits (`feat:`, `test:`, `chore:`).

## File Structure

```
tez-robotics/
  package.json  pnpm-workspace.yaml  tsconfig.base.json  vitest.workspace.ts
  docker/compose.yaml  docker/mosquitto/mosquitto.conf
  packages/
    shared/src/types.ts           # AgvPosition, CellKey, RobotId etc.
    core/src/map.ts               # WarehouseMap: graph + BFS distance tables
    core/src/router.ts            # PIBT: plan(step) → next node per robot
    core/src/reservations.ts      # ReservationTable: claim/allocate/free
    core/src/dispatcher.ts        # Hungarian assignment tick
    core/src/orders.ts            # TransportOrder state machine
    core/src/orchestrator.ts      # loop wiring all of the above
    core/test/*.test.ts
    robot-interface/src/adapter.ts       # RobotAdapter interface (protocol-blind)
    robot-interface/src/vda5050.ts       # coaty MasterController adapter
    robot-interface/test/*.test.ts
    sim/src/fleet.ts              # N VirtualAgvAdapter processes
    sim/test/e2e.test.ts
  maps/demo-grid.json             # 20x10 grid demo map
```

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.workspace.ts`, `packages/shared/src/types.ts`, `packages/shared/test/types.test.ts`, per-package `package.json`+`tsconfig.json` for shared/core/robot-interface/sim

**Interfaces:**
- Produces: `@tez/shared` exporting:

```ts
export type RobotId = string;
export type CellKey = `${number}:${number}`;
export interface GridPos { x: number; y: number; }
export const cellKey = (p: GridPos): CellKey => `${p.x}:${p.y}`;
export interface RobotState {
  id: RobotId; pos: GridPos; theta: number; battery: number; // 0..1
  status: "IDLE" | "EXECUTING" | "CHARGING" | "ERROR" | "UNKNOWN";
  currentMissionId?: string; lastSeen: string; // ISO
}
```

- [ ] **Step 1: Scaffold workspace.** Root `package.json` private, `"type":"module"`, devDeps: `typescript@^5.5`, `vitest@^2`, `@types/node@^20`. `pnpm-workspace.yaml`: `packages: ["packages/*"]`. `tsconfig.base.json`: `strict`, `module: NodeNext`, `target: ES2022`. Each package: `name: "@tez/<name>"`, main `src/index.ts`, script `test: "vitest run"`.
- [ ] **Step 2: Write failing test** `packages/shared/test/types.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { cellKey } from "../src/types.js";
it("cellKey formats grid position", () => {
  expect(cellKey({ x: 3, y: 7 })).toBe("3:7");
});
```

- [ ] **Step 3: Run `pnpm -r test`** — expect FAIL (module missing).
- [ ] **Step 4: Implement `types.ts`** per Produces block above. Run `pnpm -r test` — PASS.
- [ ] **Step 5: Commit** `chore: scaffold pnpm monorepo with shared types`

### Task 2: Mosquitto compose + broker smoke test

**Files:**
- Create: `docker/compose.yaml`, `docker/mosquitto/mosquitto.conf`, `packages/robot-interface/test/broker.test.ts`

**Interfaces:**
- Produces: broker at `mqtt://localhost:1883`, WS `ws://localhost:9001`. Test helper env `MQTT_URL` (default `mqtt://localhost:1883`).

- [ ] **Step 1: Write config.** `mosquitto.conf`:

```
listener 1883
protocol mqtt
listener 9001
protocol websockets
allow_anonymous true
```

`compose.yaml`: service `mosquitto`, image `eclipse-mosquitto:2`, ports 1883/9001, mount conf. (Auth/ACL deferred to Plan 2 hardening.)
- [ ] **Step 2: Failing test** `broker.test.ts` — connect with `mqtt` package, pub/sub roundtrip on topic `test/ping`, expect payload back within 2s. Add dep `mqtt@^5` to robot-interface.
- [ ] **Step 3: Run `docker compose -f docker/compose.yaml up -d` then test** — PASS. (Test skips with warning if broker unreachable: `it.skipIf(!process.env.CI && !brokerUp)` pattern — probe with 500ms connect timeout.)
- [ ] **Step 4: Commit** `chore: mosquitto compose stack + broker smoke test`

### Task 3: Protocol spike — coaty master ↔ virtual AGV order roundtrip

Purpose: lock the exact `vda-5050-lib` API surface early; all later VDA code builds on what this test proves.

**Files:**
- Create: `packages/robot-interface/src/spike.ts` (throwaway helpers), `packages/robot-interface/test/spike.test.ts`
- Deps: `vda-5050-lib@^1.7` into robot-interface

**Interfaces:**
- Produces: verified knowledge, recorded as comments in spike test: exact shapes of `MasterController.assignOrder`, `AgvController` + `VirtualAgvAdapter` startup options, AgvId `{manufacturer, serialNumber}`, order node/edge minimal fields.

- [ ] **Step 1: Failing integration test** (per lib docs; adjust names to compile against real lib — that adjustment IS the spike):

```ts
import { MasterController, AgvController, VirtualAgvAdapter } from "vda-5050-lib";
const agvId = { manufacturer: "tez", serialNumber: "sim-001" };
const opts = { interfaceName: "uagv", transport: { brokerUrl: process.env.MQTT_URL ?? "mqtt://localhost:1883" } };
it("virtual AGV completes a 2-node order", async () => {
  const agv = new AgvController(agvId, opts, {}, { agvAdapterType: VirtualAgvAdapter, agvAdapterOptions: { initialPosition: { mapId: "demo", x: 0, y: 0, theta: 0, lastNodeId: "n0" } } });
  await agv.start();
  const mc = new MasterController(opts, {});
  await mc.start();
  const done = new Promise<void>((res, rej) => {
    mc.assignOrder(agvId, {
      orderId: "o1", orderUpdateId: 0,
      nodes: [
        { nodeId: "n0", sequenceId: 0, released: true, nodePosition: { x: 0, y: 0, mapId: "demo" }, actions: [] },
        { nodeId: "n1", sequenceId: 2, released: true, nodePosition: { x: 1, y: 0, mapId: "demo" }, actions: [] },
      ],
      edges: [{ edgeId: "e01", sequenceId: 1, released: true, startNodeId: "n0", endNodeId: "n1", actions: [] }],
    }, { onOrderProcessed: (err) => err ? rej(err) : res() });
  });
  await expect(done).resolves.toBeUndefined();
  await mc.stop(); await agv.stop();
}, 20_000);
```

- [ ] **Step 2: Run, fix API mismatches against `node_modules/vda-5050-lib` typings until PASS.** Record every correction as a comment block at top of spike test.
- [ ] **Step 3: Commit** `test: vda-5050-lib order roundtrip spike (API surface locked)`

### Task 4: Warehouse map + BFS distance tables

**Files:**
- Create: `packages/core/src/map.ts`, `packages/core/test/map.test.ts`, `maps/demo-grid.json`

**Interfaces:**
- Produces:

```ts
export interface MapNode { id: string; pos: GridPos; charger?: boolean; }
export interface MapEdge { from: string; to: string; }  // directed; JSON loader expands bidirectional:true
export class WarehouseMap {
  static fromJSON(json: unknown): WarehouseMap;          // validates, throws on orphan edges
  neighbors(nodeId: string): string[];
  node(nodeId: string): MapNode;
  distance(fromId: string, toId: string): number;        // hops via lazy-BFS table, Infinity if unreachable
  nearestNode(pos: GridPos): string;
  get nodeIds(): string[];
}
```

- `maps/demo-grid.json`: 20×10 grid, node ids `n{x}_{y}`, all 4-neighbor edges bidirectional, chargers at x=0 column.

- [ ] **Step 1: Failing tests:** fromJSON round-trip; neighbors of corner=2/center=4; `distance("n0_0","n3_0")===3`; unreachable → Infinity; orphan edge throws.
- [ ] **Step 2: Implement.** BFS per source, memoized `Map<string, Map<string, number>>`. Grid generator helper `WarehouseMap.grid(w,h)` for tests.
- [ ] **Step 3: Tests PASS. Commit** `feat: warehouse map graph with BFS distance tables`

### Task 5: PIBT router

**Files:**
- Create: `packages/core/src/router.ts`, `packages/core/test/router.test.ts`

**Interfaces:**
- Consumes: `WarehouseMap.neighbors/distance`
- Produces:

```ts
export interface Agent { id: RobotId; at: string; goal: string; priority: number; }
export class PibtRouter {
  constructor(map: WarehouseMap);
  /** One timestep for all agents. Returns nodeId each agent occupies next step.
   *  Guarantees: no vertex conflicts, no edge swaps. Agents at goal may stay. */
  step(agents: Agent[]): Map<RobotId, string>;
}
```

- Algorithm (port of Kei18/pypibt, MIT — attribute in header comment): sort agents by priority desc; for each unassigned agent run `pibt(agent)`: candidate next nodes = neighbors+stay sorted by `distance(candidate, goal)`; skip candidates already claimed this step or causing swap; if candidate occupied by lower-priority unassigned agent, recursively push it (priority inheritance); on failure backtrack to next candidate; stay is always last resort. Priorities: base + increment each step the agent hasn't reached goal (prevents starvation), reset at goal.

- [ ] **Step 1: Failing tests:**
  - two agents head-on in a corridor (1×5 grid) swap around via siding or wait — no vertex/edge conflict at any step, both reach goals ≤ 12 steps;
  - 10 agents random goals on 20×10 grid, run 200 steps: assert every step has unique target cells and no swap `(a: u→v, b: v→u)`; all reach goals;
  - agent at goal with nobody pushing stays put.
- [ ] **Step 2: Implement (~150 LOC).** Deterministic: tie-break candidate sort by nodeId; seedable priority init.
- [ ] **Step 3: Tests PASS. Commit** `feat: PIBT multi-robot router (port of Kei18/pypibt, MIT)`

### Task 6: Cell reservation table

**Files:**
- Create: `packages/core/src/reservations.ts`, `packages/core/test/reservations.test.ts`

**Interfaces:**
- Produces:

```ts
export class ReservationTable {
  /** claim next cells for robot; returns granted prefix (may be shorter than asked) */
  claim(robot: RobotId, cells: CellKey[]): CellKey[];
  /** release all cells strictly behind current cell */
  release(robot: RobotId, current: CellKey): void;
  owner(cell: CellKey): RobotId | undefined;
  releaseAll(robot: RobotId): void;
}
```

- Semantics (openTCS-style): a cell has ≤1 owner; claim is atomic prefix-grant (stop at first foreign-owned cell); robot's motion layer may only enter granted cells — router output is filtered through this before being sent as mission horizon.

- [ ] **Step 1: Failing tests:** prefix grant stops at foreign cell; release-behind frees only trailing cells; releaseAll on robot death; double-claim same robot idempotent.
- [ ] **Step 2: Implement (Map<CellKey,RobotId> + per-robot ordered list). Tests PASS.**
- [ ] **Step 3: Commit** `feat: cell reservation table (claim/allocate/free semantics)`

### Task 7: Hungarian dispatcher

**Files:**
- Create: `packages/core/src/dispatcher.ts`, `packages/core/src/vendor/munkres.ts` (vendored munkres-js, MIT header retained), `packages/core/test/dispatcher.test.ts`

**Interfaces:**
- Consumes: `WarehouseMap.distance`, `TransportOrder` (Task 8 — for this task use minimal `{ id: string; pickupNode: string }`)
- Produces:

```ts
export interface Assignment { orderId: string; robotId: RobotId; }
export function dispatch(
  idleRobots: { id: RobotId; at: string; idleSince: number }[],
  pending: { id: string; pickupNode: string }[],
  map: WarehouseMap,
): Assignment[];
// cost = distance(robot.at, order.pickupNode) - idleBonus(idleSince); rectangular matrix padded; unreachable pairs cost=1e9 and filtered from result
```

- [ ] **Step 1: Failing tests:** 2 robots 2 orders → nearest wins; 1 robot 3 orders → single assignment; unreachable order unassigned; longer-idle robot wins tie.
- [ ] **Step 2: Vendor munkres-js (~180 LOC) with license header, implement dispatch. Tests PASS.**
- [ ] **Step 3: Commit** `feat: Hungarian dispatch tick (vendored munkres-js)`

### Task 8: TransportOrder state machine

**Files:**
- Create: `packages/core/src/orders.ts`, `packages/core/test/orders.test.ts`

**Interfaces:**
- Produces:

```ts
export type OrderStatus = "queued" | "dispatched" | "underway" | "completed" | "failed" | "canceled";
export interface TransportOrder {
  id: string; pickupNode: string; dropNode: string; status: OrderStatus;
  robotId?: RobotId; retries: number; createdAt: string; history: { at: string; from: OrderStatus; to: OrderStatus; reason?: string }[];
}
export class OrderBook {
  create(pickupNode: string, dropNode: string): TransportOrder;
  transition(id: string, to: OrderStatus, reason?: string): TransportOrder; // throws IllegalTransition
  requeue(id: string, reason: string): TransportOrder; // dispatched|underway → queued, retries+1; ≥3 retries → failed
  pending(): TransportOrder[]; byRobot(robotId: RobotId): TransportOrder | undefined;
}
```

- Legal transitions: queued→dispatched→underway→completed; any non-terminal→canceled; dispatched|underway→queued (requeue); requeue with retries≥3→failed.

- [ ] **Step 1: Failing tests:** happy path; illegal jump queued→completed throws; requeue increments retries; 3rd requeue → failed; history records reasons.
- [ ] **Step 2: Implement. Tests PASS. Commit** `feat: transport order state machine with retry/requeue`

### Task 9: RobotAdapter interface + fake adapter

**Files:**
- Create: `packages/robot-interface/src/adapter.ts`, `packages/robot-interface/src/fake.ts`, `packages/robot-interface/test/fake.test.ts`

**Interfaces:**
- Produces (the seam between core and protocols — core depends ONLY on this):

```ts
export interface Mission { id: string; robotId: RobotId; nodeIds: string[]; } // horizon path incl. current node
export type AdapterEvent =
  | { type: "state"; state: RobotState }
  | { type: "missionProgress"; robotId: RobotId; missionId: string; lastNodeId: string }
  | { type: "missionDone"; robotId: RobotId; missionId: string }
  | { type: "missionFailed"; robotId: RobotId; missionId: string; reason: string }
  | { type: "connection"; robotId: RobotId; online: boolean };
export interface RobotAdapter {
  start(): Promise<void>; stop(): Promise<void>;
  sendMission(m: Mission, map: WarehouseMap): Promise<void>; // extend = same mission id, longer nodeIds
  cancelMission(robotId: RobotId): Promise<void>;
  on(handler: (e: AdapterEvent) => void): void;
}
```

- `FakeAdapter`: in-memory, advances robots one node per `tick()`, emits events — the core test double.

- [ ] **Step 1: Failing tests:** fake robot walks 3-node mission emitting progress then done; cancel stops emission; state events carry position of current node.
- [ ] **Step 2: Implement. Tests PASS. Commit** `feat: protocol-blind RobotAdapter seam + fake adapter`

### Task 10: Orchestrator loop

**Files:**
- Create: `packages/core/src/orchestrator.ts`, `packages/core/test/orchestrator.test.ts`

**Interfaces:**
- Consumes: everything above (map, router, reservations, dispatcher, orders, RobotAdapter)
- Produces:

```ts
export class Orchestrator {
  constructor(map: WarehouseMap, adapter: RobotAdapter, opts?: { tickMs?: number; horizon?: number }); // defaults 500, 5
  start(): Promise<void>; stop(): Promise<void>;
  submitOrder(pickupNode: string, dropNode: string): TransportOrder;
  snapshot(): { robots: RobotState[]; orders: TransportOrder[]; kpis: { ordersPerHour: number; avgCycleMs: number; utilization: number } };
}
```

- Tick pipeline: ingest adapter events → update RobotStates/orders (missionDone at pickup ⇒ order underway with new mission to drop; at drop ⇒ completed) → dispatch() for idle×queued → PIBT step for active robots (goal = current leg target) → filter each robot's next-k path through ReservationTable.claim → sendMission (extend) → release cells behind reported positions. Connection offline > 10s ⇒ robot UNKNOWN + requeue its order.

- [ ] **Step 1: Failing tests (FakeAdapter, manual ticks):** single order end-to-end (queued→…→completed KPI counted); two robots two orders in parallel, no reservation violation (assert via table owner scan each tick); robot goes offline mid-order → order requeued and completed by second robot; retries exhaust → failed.
- [ ] **Step 2: Implement. Tests PASS. Commit** `feat: orchestrator tick loop (dispatch→route→reserve→execute)`

### Task 11: VDA 5050 adapter (real protocol)

**Files:**
- Create: `packages/robot-interface/src/vda5050.ts`, `packages/robot-interface/src/schemas/` (vendored VDA5050 2.1.0 JSON schemas + ajv wrapper), `packages/robot-interface/test/vda5050.test.ts`

**Interfaces:**
- Consumes: `RobotAdapter` seam (Task 9), spike-locked coaty API (Task 3), `WarehouseMap` for node positions
- Produces: `Vda5050Adapter implements RobotAdapter`, constructor `(agvIds: {manufacturer,serialNumber}[], mqttUrl: string)`. Mission→order mapping: `orderId = missionId`, extend = same orderId with `orderUpdateId+1`, nodes from map positions, sequenceIds even/odd per spec; state messages → `state` + `missionProgress` (lastNodeId) events; `onOrderProcessed` → missionDone/missionFailed; connection topic → connection events. ajv-validate orders before send and states on receive; invalid inbound → log + drop (dead-letter table arrives in Plan 2).

- [ ] **Step 1: Failing integration test:** Orchestrator + Vda5050Adapter + 3 in-process VirtualAgvAdapter AGVs on real broker; submit 5 orders; all complete ≤ 60s; no reservation violation.
- [ ] **Step 2: Implement adapter. Tests PASS.**
- [ ] **Step 3: Commit** `feat: VDA 5050 adapter over coaty MasterController with ajv boundary validation`

### Task 12: Sim fleet process + E2E soak

**Files:**
- Create: `packages/sim/src/fleet.ts`, `packages/sim/src/cli.ts` (`node cli.js --map maps/demo-grid.json --robots 10`), `packages/sim/test/e2e.test.ts`

**Interfaces:**
- Consumes: coaty AgvController+VirtualAgvAdapter (spike API), map JSON
- Produces: standalone process spawning N virtual AGVs (ids `sim-001…`), battery drain + charge action support, `--fail-robot <id>@<sec>` failure injection flag.

- [ ] **Step 1: Failing E2E:** compose broker up; spawn fleet(10) as child process; Orchestrator with Vda5050Adapter; feed 50 orders; assert: all terminal ≤ 5 min, ≥95% completed, zero reservation violations, KPI snapshot sane (ordersPerHour > 0, utilization ≤ 1).
- [ ] **Step 2: Implement fleet + CLI. E2E PASS.**
- [ ] **Step 3: Commit** `feat: sim fleet process with failure injection + e2e soak test`

---

## Self-review notes
- Spec coverage: map/router/traffic/dispatcher/orders/orchestrator/adapter/sim ✅. Deferred to Plan 2 per spec milestones: Postgres persistence, REST/WS API, dashboard, dead-letter table, broker auth, Python interop CI. Plan 3: 1C connector. KPI minimal in-memory version included (Task 10) since spec ties KPIs to core loop.
- Type consistency pass done: `RobotState`/`Mission`/`Assignment`/`TransportOrder` names match across tasks.
- Placeholder scan: none — spike task (3) exists precisely to eliminate the one unknown (coaty exact API) with a test, not a TODO.
