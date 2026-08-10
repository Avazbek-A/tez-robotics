# Tez Robotics

**Warehouse robotics for Uzbekistan & Central Asia** — AMR fleet integration plus our own orchestration platform with native 1C/WMS integration.

> Uzbekistan has zero local warehouse-robotics integrators. When the country's largest marketplace robotized its warehouse, the contractor had to come from abroad. Tez Robotics is building the local layer: deployment, orchestration software, and 24/7 on-site service.

## What's in this repository

| Module | Status | Description |
|---|---|---|
| [`orchestrator-demo/`](orchestrator-demo/) | ✅ working demo | Fleet orchestration simulation: task allocation, A* routing, conflict resolution, charging management, live KPI dashboard (RU/UZ/EN) |
| `safety-cv/` | in development | Computer-vision safety module on existing CCTV: PPE compliance, hazard zones, forklift–pedestrian proximity |
| `1c-connector/` | planned | Native 1C integration layer — order intake and inventory sync for the orchestrator |

## Orchestrator demo

Warehouse simulation demonstrating the software layer we build on top of series-production AMRs:

- **Task allocation** — cost-based dispatcher assigns incoming 1C/WMS orders to the nearest available robot
- **Routing** — A* pathfinding with cell-reservation conflict resolution between robots
- **Fleet management** — battery model, automatic charging, per-robot state tracking
- **Live KPIs** — orders/hour, average cycle time, fleet utilization, distance traveled, staff walking saved
- **Trilingual UI** — Russian, Uzbek, English

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
