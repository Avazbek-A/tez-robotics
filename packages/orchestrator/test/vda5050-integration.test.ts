import { describe, it, expect } from "vitest";
import { WarehouseMap } from "@tez/core";
import { startDevBroker, Vda5050Adapter, type DevBrokerResult, type AdapterEvent } from "@tez/robot-interface";
import { AgvController, VirtualAgvAdapter, type AgvId } from "vda-5050-lib";
import { Orchestrator } from "../src/orchestrator.js";

/**
 * Fleet-scale integration test for the real VDA 5050 adapter (Task 11):
 * Orchestrator + Vda5050Adapter + 3 in-process VirtualAgvAdapter AGVs, all
 * talking over one real (in-process) MQTT broker.
 *
 * This deliberately does NOT use `orchestrator.tickOnce()` in lockstep with
 * a manually-driven fake adapter the way `orchestrator.test.ts` does.
 * Instead it calls `orchestrator.start()`, which drives itself off a
 * wall-clock `setInterval` (see the LOCKSTEP PRECONDITION doc comment on
 * `Orchestrator.runRouting` in `../src/orchestrator.ts`) — exactly the mode
 * a real adapter runs in. The AGVs move continuously and report state on
 * their own cadence, independent of the orchestrator's tick boundary.
 *
 * Collision checking is adapted accordingly: rather than asserting zero
 * shared-cell ticks against a single lockstepped snapshot (impossible here
 * since ticks and AGV movement are not interleaved 1:1 — see the
 * LOCKSTEP PRECONDITION note), this test listens to the adapter's own
 * `state` AdapterEvents directly (bypassing the orchestrator entirely) and
 * flags any two robots reporting positions within a small tolerance of each
 * other at overlapping times — i.e. a genuine "in the same place" event,
 * not just "unlucky polling".
 */
describe("VDA 5050 adapter fleet integration", () => {
  it(
    "completes 5 submitted orders across 3 real-protocol AGVs within 60s, with no observed same-cell collisions",
    async () => {
      // A larger grid with robot homes and order endpoints kept away from
      // the grid boundary (which has fewer neighbor cells to detour
      // through) and spread across different regions, so the 3 robots'
      // routes rarely need to cross the same cell head-on. A tighter,
      // boundary-hugging layout was found (via a standalone PibtRouter
      // repro, see task-11-report.md) to trigger a genuine pre-existing
      // `PibtRouter` limitation: two agents routed in opposite directions
      // through a single-file boundary column can oscillate forever
      // instead of one of them detouring — a `packages/core` router issue
      // out of scope for this adapter task, not something introduced here.
      const size = 8;
      const map = WarehouseMap.fromJSON(WarehouseMap.grid(size, size));

      const robotSpecs: Array<{ manufacturer: string; serialNumber: string; startNodeId: string }> = [
        { manufacturer: "tez", serialNumber: "r1", startNodeId: "n1_1" },
        { manufacturer: "tez", serialNumber: "r2", startNodeId: "n6_1" },
        { manufacturer: "tez", serialNumber: "r3", startNodeId: "n1_6" },
      ];

      let devBroker: DevBrokerResult | undefined;
      const agvControllers: AgvController[] = [];
      let adapter: Vda5050Adapter | undefined;
      let orchestrator: Orchestrator | undefined;

      try {
        devBroker = await startDevBroker({ port: 0, wsPort: 0 });
        const clientOptions = {
          interfaceName: "uagv",
          transport: { brokerUrl: devBroker.url },
          vdaVersion: "2.0.0" as const,
        };

        for (const spec of robotSpecs) {
          const agvId: AgvId = { manufacturer: spec.manufacturer, serialNumber: spec.serialNumber };
          const pos = map.node(spec.startNodeId).pos;
          const agv = new AgvController(
            agvId,
            clientOptions,
            { agvAdapterType: VirtualAgvAdapter, publishStateInterval: 100 },
            {
              initialPosition: { mapId: "warehouse", x: pos.x, y: pos.y, theta: 0, lastNodeId: spec.startNodeId },
              vehicleSpeed: 2.5,
            }
          );
          await agv.start();
          agvControllers.push(agv);
        }

        adapter = new Vda5050Adapter(
          robotSpecs.map((s) => ({ manufacturer: s.manufacturer, serialNumber: s.serialNumber })),
          devBroker.url,
          { interfaceName: "uagv" }
        );

        // Independent collision watch, driven directly off adapter state
        // events (see class doc comment above for why this replaces the
        // FakeAdapter tests' lockstepped assertNoCollision()).
        const lastSeenPos = new Map<string, { x: number; y: number; atMs: number }>();
        const collisions: string[] = [];
        const COLLISION_EPS = 0.35; // well under the 1.0 grid spacing
        // A robot occupies a single cell for roughly cellSize/vehicleSpeed =
        // 1/4 = 250ms at the vehicleSpeed used below, so two same-cell
        // readings more than that far apart almost certainly reflect
        // sequential (safe) use of the cell, not an actual overlap. Keep
        // this tight — a generous window (e.g. 1s) flags busy-but-safe
        // sequential cell reuse as a false "collision".
        const STALE_MS = 150;

        adapter.on((e: AdapterEvent) => {
          if (e.type !== "state") return;
          const now = Date.now();
          const { id, pos } = e.state;
          for (const [otherId, other] of lastSeenPos) {
            if (otherId === id) continue;
            if (now - other.atMs > STALE_MS) continue;
            const dx = pos.x - other.x;
            const dy = pos.y - other.y;
            if (Math.sqrt(dx * dx + dy * dy) < COLLISION_EPS) {
              collisions.push(
                `${id} at (${pos.x.toFixed(2)},${pos.y.toFixed(2)}) collided with ${otherId} at (${other.x.toFixed(2)},${other.y.toFixed(2)}) @ t=${now}`
              );
            }
          }
          lastSeenPos.set(id, { x: pos.x, y: pos.y, atMs: now });
        });

        orchestrator = new Orchestrator(map, adapter, { tickMs: 200 });
        await orchestrator.start();

        // Each order's pickup/drop pair is kept within its own small local
        // zone, and zones are spread across the grid, so the 5 orders'
        // shortest paths mostly don't cross the same cell at all (further
        // reducing the odds of hitting the collision risk documented above
        // — this is about avoiding it in THIS demonstration, not a general
        // fix).
        const orderSpecs: Array<[string, string]> = [
          ["n1_1", "n2_3"],
          ["n6_1", "n5_3"],
          ["n1_6", "n2_7"],
          ["n6_6", "n5_7"],
          ["n3_1", "n4_2"],
        ];
        const orders = orderSpecs.map(([pickup, drop]) => orchestrator!.submitOrder(pickup, drop));

        const deadline = Date.now() + 55_000;
        let allCompleted = false;
        while (Date.now() < deadline) {
          const snap = orchestrator.snapshot();
          allCompleted = orders.every((o) => {
            const found = snap.orders.find((so) => so.id === o.id);
            return found?.status === "completed";
          });
          if (allCompleted) break;
          await new Promise((r) => setTimeout(r, 250));
        }

        if (!allCompleted) {
          const snap = orchestrator.snapshot();
          const statuses = orders.map((o) => {
            const found = snap.orders.find((so) => so.id === o.id);
            return `${o.id}:${found?.status}:${found?.robotId}`;
          });
          throw new Error(
            `not all orders completed within timeout. statuses=${statuses.join(", ")} recentAlarms=${orchestrator
              .getAlarms()
              .slice(-10)
              .join(" | ")}`
          );
        }

        expect(allCompleted).toBe(true);
        expect(collisions).toEqual([]);
      } finally {
        if (orchestrator) await orchestrator.stop();
        if (adapter) await adapter.stop();
        for (const agv of agvControllers) {
          await agv.stop().catch(() => {});
        }
        if (devBroker) await devBroker.close();
      }
    },
    60_000
  );
});
