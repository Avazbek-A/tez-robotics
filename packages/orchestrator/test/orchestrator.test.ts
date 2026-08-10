import { describe, it, expect, beforeEach } from "vitest";
import { WarehouseMap } from "@tez/core";
import { FakeAdapter } from "@tez/robot-interface";
import type { RobotState } from "@tez/shared";
import { Orchestrator } from "../src/orchestrator.js";

/**
 * Deterministic, manually-advanced clock for injectable `now`.
 */
function fakeClock(startMs = 0) {
  let ms = startMs;
  return {
    now: () => ms,
    advance: (delta: number) => {
      ms += delta;
    },
  };
}

function grid(size: number): WarehouseMap {
  return WarehouseMap.fromJSON(WarehouseMap.grid(size, size));
}

/** Advance the fleet by one physical step: adapter moves, then orchestrator decides. */
function step(orchestrator: Orchestrator, adapter: FakeAdapter): void {
  adapter.tick();
  orchestrator.tickOnce();
}

/** Assert no two robots occupy the same grid cell. */
function assertNoCollision(robots: RobotState[], msg?: string): void {
  const seen = new Map<string, string>();
  for (const r of robots) {
    const key = `${r.pos.x}:${r.pos.y}`;
    const prior = seen.get(key);
    expect(prior, `${msg ?? ""} cell ${key} occupied by both ${prior} and ${r.id}`).toBeUndefined();
    seen.set(key, r.id);
  }
}

describe("Orchestrator", () => {
  describe("single order end-to-end", () => {
    it("takes a queued order through dispatch, pick, drop, to completed", () => {
      const map = grid(4);
      const adapter = new FakeAdapter([{ id: "r1", startNodeId: "n0_0" }], map);
      const clock = fakeClock();
      const orchestrator = new Orchestrator(map, adapter, { now: clock.now });

      const order = orchestrator.submitOrder("n2_0", "n3_3");
      expect(order.status).toBe("queued");

      let completed = false;
      for (let i = 0; i < 60 && !completed; i++) {
        step(orchestrator, adapter);
        const snap = orchestrator.snapshot();
        const found = snap.orders.find((o) => o.id === order.id);
        if (found?.status === "completed") completed = true;
      }

      expect(completed).toBe(true);
      const snap = orchestrator.snapshot();
      const finalOrder = snap.orders.find((o) => o.id === order.id);
      expect(finalOrder?.status).toBe("completed");
      expect(finalOrder?.robotId).toBe("r1");
      expect(snap.kpis.avgCycleMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("two robots, two orders, parallel — no collision", () => {
    it("routes both orders concurrently with zero shared-cell ticks", () => {
      const map = grid(5);
      const adapter = new FakeAdapter(
        [
          { id: "r1", startNodeId: "n0_0" },
          { id: "r2", startNodeId: "n4_4" },
        ],
        map
      );
      const clock = fakeClock();
      const orchestrator = new Orchestrator(map, adapter, { now: clock.now });

      const order1 = orchestrator.submitOrder("n4_0", "n4_4");
      const order2 = orchestrator.submitOrder("n0_4", "n0_0");

      let bothDone = false;
      for (let i = 0; i < 100 && !bothDone; i++) {
        step(orchestrator, adapter);
        assertNoCollision(adapter.robots(), `tick ${i}`);
        const snap = orchestrator.snapshot();
        const o1 = snap.orders.find((o) => o.id === order1.id);
        const o2 = snap.orders.find((o) => o.id === order2.id);
        bothDone = o1?.status === "completed" && o2?.status === "completed";
      }

      expect(bothDone).toBe(true);
    });
  });

  describe("offline robot mid-order", () => {
    it("requeues the order after the grace period and a second robot completes it", () => {
      const map = grid(5);
      const adapter = new FakeAdapter(
        [
          { id: "r1", startNodeId: "n0_0" },
          { id: "r2", startNodeId: "n4_0" },
        ],
        map
      );
      const clock = fakeClock();
      const orchestrator = new Orchestrator(map, adapter, {
        now: clock.now,
        offlineGraceMs: 5_000,
      });

      const order = orchestrator.submitOrder("n2_2", "n0_4");

      // Let dispatch happen and the winning robot start moving.
      step(orchestrator, adapter);
      step(orchestrator, adapter);

      let dispatchedOrder = orchestrator.snapshot().orders.find((o) => o.id === order.id);
      expect(dispatchedOrder?.status).toBe("dispatched");
      const originalRobot = dispatchedOrder?.robotId as string;
      expect(["r1", "r2"]).toContain(originalRobot);

      // Drop the assigned robot's connection.
      adapter.setConnection(originalRobot as never, false);
      orchestrator.tickOnce();

      // Advance the clock past the grace period without moving adapter time
      // (robot is offline, so its own tick() calls are inert anyway).
      clock.advance(6_000);
      orchestrator.tickOnce();

      const afterGrace = orchestrator.snapshot().orders.find((o) => o.id === order.id);
      expect(afterGrace?.retries).toBeGreaterThanOrEqual(1);
      expect(["queued", "dispatched", "underway"]).toContain(afterGrace?.status);
      // Order is no longer bound to the robot that went offline.
      expect(afterGrace?.robotId).not.toBe(originalRobot);

      // The offline robot should now read UNKNOWN in the snapshot.
      const offlineRobotState = orchestrator
        .snapshot()
        .robots.find((r) => r.id === originalRobot);
      expect(offlineRobotState?.status).toBe("UNKNOWN");

      // Bring the fleet home: the other robot should pick up the requeued
      // order and complete it.
      let completed = false;
      for (let i = 0; i < 100 && !completed; i++) {
        step(orchestrator, adapter);
        const snap = orchestrator.snapshot();
        const found = snap.orders.find((o) => o.id === order.id);
        if (found?.status === "completed") completed = true;
      }

      expect(completed).toBe(true);
      const finalOrder = orchestrator.snapshot().orders.find((o) => o.id === order.id);
      expect(finalOrder?.robotId).not.toBe(originalRobot);
    });
  });

  describe("retries exhausted", () => {
    it("fails the order after three requeues", () => {
      const map = grid(3);
      const adapter = new FakeAdapter([{ id: "r1", startNodeId: "n0_0" }], map);
      const clock = fakeClock();
      const orchestrator = new Orchestrator(map, adapter, { now: clock.now });

      const order = orchestrator.submitOrder("n2_0", "n2_2");

      for (let attempt = 0; attempt < 3; attempt++) {
        // Let dispatch (re)assign the order to r1 and send a mission.
        let dispatched = false;
        for (let i = 0; i < 20 && !dispatched; i++) {
          step(orchestrator, adapter);
          const snap = orchestrator.snapshot();
          const found = snap.orders.find((o) => o.id === order.id);
          dispatched = found?.status === "dispatched" || found?.status === "underway";
        }
        expect(dispatched).toBe(true);

        // Let one real heartbeat through so the orchestrator's cached robot
        // state actually reflects EXECUTING before we fail the mission
        // (mirrors a real robot: the state telemetry that confirms it
        // started arrives shortly after the command was sent).
        step(orchestrator, adapter);

        adapter.failMission("r1" as never, `simulated failure #${attempt + 1}`);
        orchestrator.tickOnce();

        const snap = orchestrator.snapshot();
        const found = snap.orders.find((o) => o.id === order.id);
        expect(found?.retries).toBe(attempt + 1);

        if (attempt < 2) {
          // With a single robot in the fleet, requeue and re-dispatch can
          // both land within the same tick that processed the failure, so
          // the observable status may already be "dispatched"/"underway"
          // again rather than sitting at "queued". What matters is the
          // order is still alive (not terminal) and the retry counter
          // advanced.
          expect(["queued", "dispatched", "underway"]).toContain(found?.status);
        } else {
          expect(found?.status).toBe("failed");
        }
      }

      const finalOrder = orchestrator.snapshot().orders.find((o) => o.id === order.id);
      expect(finalOrder?.status).toBe("failed");
      expect(finalOrder?.retries).toBe(3);
    });
  });
});
