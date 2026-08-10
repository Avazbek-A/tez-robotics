# Tez Orchestrator — Design Spec
Date: 2026-08-10. Status: approved. Scope: production-grade AMR fleet orchestration platform (pilot-ready), replacing the throwaway `orchestrator-demo/` simulation.

## Goals
- Real fleet orchestration core: order intake → task dispatch → multi-robot routing → execution tracking → KPIs.
- Robots are external clients speaking real protocols over MQTT/TCP. Simulated robots use the same interface as physical ones — a physical AMR plugs in with zero core changes.
- Native 1C order intake (OData) as the regional differentiator.
- Runs identically on a MacBook and a cheap VPS via docker-compose.

## Non-goals (v1)
- No robot-side navigation (robots own SLAM/motion; we dispatch and route at graph level).
- No multi-warehouse tenancy, no auth beyond basic API tokens, no VDA 5050 3.0.
- No per-brand OEM fleet-manager adapters (Geek+/Hikrobot REST) — deferred.

## Architecture

```
                 ┌────────────────────────────────────────────┐
 1C / WMS ──OData──▶│ connector-1c │                          │
                 │              ▼                             │
  Dashboard ◀─WS──│  api (Fastify): REST + WebSocket          │
      ▲          │              ▼                             │
      │          │  core: order model → dispatcher (Hungarian)│
   MQTT.js       │        → router (windowed PIBT)            │
      │          │        → traffic (cell reservation)        │
      │          │              ▼                             │
      └──────────│  robot-interface: adapter registry         │
                 │   ├─ vda5050 adapter (coaty MasterController)│
                 │   ├─ seer-tcp adapter (RoboKit, later)      │
                 │   └─ modbus adapter (peripherals, later)    │
                 └───────┬────────────────────────────────────┘
                         │ MQTT (Mosquitto)          
              ┌──────────┴───────────┐
              │ sim fleet: N virtual │  ← coaty VirtualAgvAdapter,
              │ AGVs (own process)   │    separate process, real protocol
              └──────────────────────┘
```

Single Node service (modular monolith) + separate sim-fleet process + Postgres + Mosquitto. Service split follows NVIDIA isaac_mission_dispatch pattern (mission DB/API vs dispatch loop) but in-process modules, not microservices.

## Components

### robot-interface (adapter layer)
- `RobotAdapter` interface: `assignOrder(robotId, order)`, `cancelOrder`, `instantAction`, events `onState`, `onConnection`, `onOrderEvent`. Core never imports protocol types.
- v1 adapter: VDA 5050 via `vda-5050-lib` MasterController. Wire target 2.0, types 2.1. ajv validation against vendored official JSON schemas (tag 2.1.0) at the MQTT boundary.
- Order-lifecycle edge cases (order splitting, base/horizon, CONNECTIONBROKEN → robot UNKNOWN) follow openTCS commadapter-vda5050 documented behavior.

### core
- **Domain model** (openTCS-inspired): `Map` (nodes/edges graph, LIF-compatible naming), `Robot`, `TransportOrder` (pick→drop, status machine modeled on Open-RMF task states: queued → dispatched → underway(phase) → completed | failed | canceled), `Mission` (robot-level VDA5050 order).
- **Dispatcher**: every tick (500ms) Hungarian assignment (vendored munkres) over idle robots × pending orders; cost = precomputed BFS distance + idle-time tiebreak. Reassignment only on robot failure.
- **Router**: windowed PIBT (port of Kei18/pypibt, MIT) over the warehouse graph; per-goal BFS distance tables precomputed on map load. Output: next-k-nodes horizon per robot, re-planned each step — delays absorbed natively.
- **Traffic safety**: independent cell-reservation table (openTCS scheduler semantics: claim ahead k cells → allocate → free behind). Router optimism never bypasses reservations; narrow aisles = single-owner resource sets. This is the deadlock backstop.
- **KPIs**: orders/hour, avg cycle time, fleet utilization, distance, queue depth — computed in-process, snapshotted to DB.

### api
- Fastify REST: CRUD orders, robots, map upload, KPI queries. OpenAPI generated.
- WebSocket: state stream (robot poses, order status, alarms) for dashboard; batched at 10Hz.

### persistence
- Postgres 16. Tables: `robots`, `transport_orders` (+ history/audit), `missions`, `state_snapshots` (JSONB raw VDA5050 state, BRIN index, cron retention), `kpi_snapshots`. pg-boss only if delayed jobs appear.

### sim fleet
- Separate Node process: N coaty VirtualAgvAdapter instances, config = same map file. Battery model, charging actions, failure injection flags.
- Interop check in CI: taherfattahi/vda5050-robot-simulator (Python, MIT) run against master to catch self-compat bugs.

### dashboard
- React 18 + TS + Vite. PixiJS v8 + pixi-viewport live map: floor grid, racks, robot sprites + paths + selection; imperative updates from zustand store, rAF-batched — 60fps at 50 robots. shadcn/ui + Recharts: task queue, robot cards (battery/state/errors), KPI row, alarm list. RU/UZ/EN i18n (carry keys from orchestrator-demo).
- Dev-time debugging: bekirbostanci vda5050_visualizer as standalone GPL tool (never embedded).

### connector-1c
- Thin OData client (axios): poll `Document_ЗаказКлиента` by status → map lines to TransportOrders; on completion PATCH status / POST movement doc + `/Post`. Handles tabular-part full-row PATCH rule.
- Env-switch between live 1C (1C:Fresh / Clobus.uz tenant) and bundled mock OData server (same URL shapes) for offline demos.

## Error handling
- Robot connection loss: MQTT last-will → connection topic → robot marked UNKNOWN, its order back to queue after grace period.
- Order rejection / action failure: mission → failed, TransportOrder → queue with retry count, alarm raised.
- Broker down: api serves cached state read-only, reconnect with backoff; sim robots reconnect independently.
- All protocol messages schema-validated; invalid → dead-letter log table, never crash the loop.

## Testing
- Unit: PIBT port vs pypibt reference scenarios (fixture parity), reservation table invariants, Hungarian dispatch determinism.
- Integration: docker-compose up → 10 virtual AGVs → scripted order batch → assert throughput, zero collisions (reservation invariant), order lifecycle terminal states.
- Interop: Python simulator suite in CI.
- Load: 50 robots × 500 orders soak on MacBook.

## Deployment
docker-compose: `mosquitto` (1883 + WS 9001, passwd/ACL), `api`, `postgres`, `caddy` (TLS/WSS), optional `sim`. One `.env`. Same file dev/prod.

## Milestones (~14 working days)
1. **D1–2**: scaffold monorepo (pnpm), compose stack, coaty master + 5 virtual AGVs exchanging orders, visualizer confirming traffic.
2. **D3–5**: map model + PIBT port + reservations + Hungarian dispatcher; soak test green.
3. **D6–8**: Postgres schema + REST/WS API + Pixi dashboard MVP.
4. **D9–10**: 1C connector (mock + 1C:Fresh live), demo scenario scripts.
5. **D11–12**: polish, failure injection, KPI tuning, RU/UZ/EN.
6. **D13–14**: hardening, load test, demo capture for PTA video.
