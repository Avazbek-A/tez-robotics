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

TypeScript monorepo implementing the real orchestration layer — robots connect as external clients over **VDA 5050 2.0 / MQTT**, so a physical AMR plugs in with zero core changes:

- **`@tez/core`** — warehouse map graph, PIBT multi-robot router (scales to 1000+ agents, deadlock-resolving), cell-reservation table, Hungarian assignment dispatcher, transport-order state machine
- **`@tez/robot-interface`** — protocol-agnostic adapter seam + real VDA 5050 adapter (built on the MIT-licensed Siemens `vda-5050-lib`); adapter architecture ready for vendor-specific protocols
- **`@tez/orchestrator`** — the control loop: dispatch → route → reserve → execute, offline-robot recovery, quarantine, live KPIs
- **`@tez/sim`** — simulated AMR fleet speaking real VDA 5050 over a real broker, failure-injection end-to-end soak tests

149 tests including multi-minute fleet soaks with robot-failure injection. Known v1 limits are documented in [`docs/BACKLOG.md`](docs/BACKLOG.md).

```bash
corepack pnpm install
corepack pnpm -r test        # full suite incl. e2e soak (~10 min, serialized)
```

## Browser demo (`orchestrator-demo/`)

```bash
cd orchestrator-demo
npm install
npm run dev
```

## Why robots + local software

- Uzbekistan's e-commerce and distribution are growing fast; warehouses still run on foot while the workforce emigrates
- Global AMR vendors' fleet software has no 1C integration — the de-facto accounting standard of the region — and no localization
- Service contracts require presence: a fly-in foreign integrator cannot reach a Tashkent warehouse in an hour

**Model:** regional integration partner of global AMR vendors + our own orchestration and safety software + local 24/7 service.

## Team

- **Avazbek Abdusaidov** — founder. Logistics (Inha University), 3 years of hardware import operations from China (Tez Motors), AI engineer with 3 products in production.

---

*Tez Robotics · Tashkent, Uzbekistan · 2026*
