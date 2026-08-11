import { describe, it, expect } from "vitest";
import { WarehouseMap } from "@tez/core";
import { FakeAdapter } from "@tez/robot-interface";
import type { AdapterEvent } from "@tez/robot-interface";
import type { RobotId, RobotState } from "@tez/shared";
import { Orchestrator } from "../src/orchestrator.js";

/**
 * FakeAdapter subclass whose cancelMission() always rejects — simulating a
 * robot that is genuinely unreachable (as an offline robot really would
 * be). The orchestrator's cancelMission calls are all best-effort
 * (`.catch()`-swallowed), so with the *real* FakeAdapter, cancelMission
 * would actually succeed and quietly clear the robot's stale mission,
 * masking the stale-reporter bug (C1) this file's "revived robot" test
 * exists to catch. This subclass keeps that mission alive so the robot can
 * genuinely go on to report a stale missionDone after reviving.
 */
class UncancellableFakeAdapter extends FakeAdapter {
  override async cancelMission(_robotId: RobotId): Promise<void> {
    throw new Error("robot unreachable");
  }
}

/**
 * FakeAdapter subclass that (a) records every cancelMission() call and (b)
 * exposes the handler the orchestrator registered via on(), so a test can
 * directly inject an arbitrary AdapterEvent — bypassing FakeAdapter's own
 * tick()-driven mission simulation entirely.
 *
 * This is needed for the round-2 regression test: a stale missionDone for
 * an OLD order (A) arriving strictly AFTER the robot has already been
 * legitimately reassigned to a NEW order (B) cannot be reproduced by
 * simply letting the old FakeAdapter mission run its course, because
 * sendMission()'s "new mission" branch (different mission id) overwrites
 * FakeAdapter's internal mission object as soon as B is dispatched —
 * silently discarding whatever was left of the stale A mission before it
 * could ever fire its own missionDone. Real robots don't have that
 * property (a command in flight and a stale ack can race independently
 * over the network), so this test fabricates the race directly by
 * injecting the stale event at the exact moment desired.
 */
class ScriptableAdapter extends FakeAdapter {
  cancelCalls: RobotId[] = [];
  private capturedHandler?: (e: AdapterEvent) => void;

  override on(handler: (e: AdapterEvent) => void): void {
    this.capturedHandler = handler;
    super.on(handler);
  }

  override async cancelMission(robotId: RobotId): Promise<void> {
    this.cancelCalls.push(robotId);
    return super.cancelMission(robotId);
  }

  injectEvent(e: AdapterEvent): void {
    if (!this.capturedHandler) throw new Error("no handler registered yet");
    this.capturedHandler(e);
  }
}

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

  describe("submitOrder validation", () => {
    it("rejects an order referencing an unknown node and the order is never created", () => {
      const map = grid(4);
      const adapter = new FakeAdapter([{ id: "r1", startNodeId: "n0_0" }], map);
      const clock = fakeClock();
      const orchestrator = new Orchestrator(map, adapter, { now: clock.now });

      expect(() => orchestrator.submitOrder("bogus-node", "n3_3")).toThrow();
      expect(() => orchestrator.submitOrder("n2_0", "bogus-node")).toThrow();

      const snap = orchestrator.snapshot();
      expect(snap.orders.length).toBe(0);
    });

    it("does not freeze the fleet: a rejected submission does not block a valid order's own completion", () => {
      const map = grid(4);
      const adapter = new FakeAdapter([{ id: "r1", startNodeId: "n0_0" }], map);
      const clock = fakeClock();
      const orchestrator = new Orchestrator(map, adapter, { now: clock.now });

      expect(() => orchestrator.submitOrder("bogus-node", "n3_3")).toThrow();

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
      expect(orchestrator.getAlarms().some((a) => a.includes("tick threw"))).toBe(false);
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

  describe("C1: stale mission report from a revived, reassigned-away robot", () => {
    it("ignores a late missionDone from a robot that is no longer the order's holder", () => {
      const map = grid(5);
      // cancelMission always fails here, so the offline-handling path's
      // best-effort cancel does NOT actually stop r1's stale mission —
      // exactly like a real unreachable robot. Without the C1 guard, r1's
      // eventual (stale) missionDone would corrupt r2's in-progress order.
      const adapter = new UncancellableFakeAdapter(
        [
          { id: "r1", startNodeId: "n0_0" },
          { id: "r2", startNodeId: "n4_4" },
        ],
        map
      );
      const clock = fakeClock();
      const orchestrator = new Orchestrator(map, adapter, {
        now: clock.now,
        offlineGraceMs: 5_000,
      });

      const order = orchestrator.submitOrder("n2_0", "n4_4");

      // r1 (much closer to the pickup) wins the dispatch and starts moving.
      step(orchestrator, adapter);
      step(orchestrator, adapter);
      let dispatched = orchestrator.snapshot().orders.find((o) => o.id === order.id);
      expect(dispatched?.robotId).toBe("r1");

      // Knock r1 offline mid-:pick, then let the grace period expire.
      adapter.setConnection("r1", false);
      orchestrator.tickOnce();
      clock.advance(6_000);
      orchestrator.tickOnce();

      const afterGrace = orchestrator.snapshot().orders.find((o) => o.id === order.id);
      expect(afterGrace?.retries).toBe(1);
      // r2 should have inherited the order (dispatch runs in the same tick
      // the requeue happened, since r2 was already idle).
      expect(afterGrace?.robotId).toBe("r2");

      // Revive r1. Its internal FakeAdapter mission was never actually
      // cancelled (cancelMission rejects), so it resumes walking its OLD
      // ":pick" path and will eventually fire a stale missionDone.
      adapter.setConnection("r1", true);
      orchestrator.tickOnce();

      let staleReportSeen = false;
      for (let i = 0; i < 10 && !staleReportSeen; i++) {
        step(orchestrator, adapter);
        staleReportSeen = orchestrator
          .getAlarms()
          .some((a) => a.includes("stale missionDone") && a.includes("r1"));
      }
      expect(staleReportSeen).toBe(true);

      // The order must still be legitimately bound to r2, untouched by r1's
      // stale report — not reset to "dispatched" for r1, not corrupted.
      const afterStale = orchestrator.snapshot().orders.find((o) => o.id === order.id);
      expect(afterStale?.robotId).toBe("r2");
      expect(["dispatched", "underway"]).toContain(afterStale?.status);

      // r2 must be able to finish the order normally.
      let completed = false;
      for (let i = 0; i < 40 && !completed; i++) {
        step(orchestrator, adapter);
        const snap = orchestrator.snapshot();
        const found = snap.orders.find((o) => o.id === order.id);
        completed = found?.status === "completed";
      }
      expect(completed).toBe(true);
      const finalOrder = orchestrator.snapshot().orders.find((o) => o.id === order.id);
      expect(finalOrder?.robotId).toBe("r2");

      // r1 must not be permanently excluded from dispatch by the stray
      // report: a fresh order near r1 should go straight to it.
      const order2 = orchestrator.submitOrder("n0_0", "n0_1");
      let order2Dispatched = false;
      for (let i = 0; i < 10 && !order2Dispatched; i++) {
        adapter.tick();
        orchestrator.tickOnce();
        const found2 = orchestrator.snapshot().orders.find((o) => o.id === order2.id);
        order2Dispatched = found2?.status === "dispatched";
      }
      const order2State = orchestrator.snapshot().orders.find((o) => o.id === order2.id);
      expect(order2State?.robotId).toBe("r1");
    });
  });

  describe("requeue from underway (offline during the drop leg)", () => {
    it("restarts the order from a fresh pick leg on the replacement robot", () => {
      const map = grid(5);
      const adapter = new FakeAdapter(
        [
          { id: "r1", startNodeId: "n0_0" },
          { id: "r2", startNodeId: "n4_4" },
        ],
        map
      );
      const clock = fakeClock();
      const orchestrator = new Orchestrator(map, adapter, {
        now: clock.now,
        offlineGraceMs: 5_000,
      });

      // Pickup close to r1 so it reaches "underway" quickly; drop far away
      // so there's plenty of runway on the drop leg to knock it offline.
      const order = orchestrator.submitOrder("n1_0", "n4_4");

      let underway = false;
      for (let i = 0; i < 10 && !underway; i++) {
        step(orchestrator, adapter);
        const found = orchestrator.snapshot().orders.find((o) => o.id === order.id);
        underway = found?.status === "underway";
      }
      expect(underway).toBe(true);
      const midDrop = orchestrator.snapshot().orders.find((o) => o.id === order.id);
      expect(midDrop?.robotId).toBe("r1");

      // Knock r1 offline mid-:drop and let the grace period expire.
      adapter.setConnection("r1", false);
      orchestrator.tickOnce();
      clock.advance(6_000);
      orchestrator.tickOnce();

      const afterGrace = orchestrator.snapshot().orders.find((o) => o.id === order.id);
      expect(afterGrace?.retries).toBe(1);
      expect(afterGrace?.robotId).toBe("r2");
      // Reassignment always starts from a fresh :pick leg, regardless of
      // how far along the original robot was.
      expect(["dispatched"]).toContain(afterGrace?.status);

      let completed = false;
      for (let i = 0; i < 40 && !completed; i++) {
        step(orchestrator, adapter);
        const found = orchestrator.snapshot().orders.find((o) => o.id === order.id);
        completed = found?.status === "completed";
      }
      expect(completed).toBe(true);

      const finalOrder = orchestrator.snapshot().orders.find((o) => o.id === order.id);
      expect(finalOrder?.robotId).toBe("r2");
      const pickTransitions = finalOrder?.history.filter(
        (h) => h.from === "dispatched" && h.to === "underway"
      );
      // Once for r1's original pickup, once for r2's fresh pickup after
      // the requeue-from-underway restart.
      expect(pickTransitions).toHaveLength(2);
    });
  });

  describe("round 2: stale report for a robot reassigned to a DIFFERENT order", () => {
    it("does not cancel or clear the robot's live, unrelated mission", () => {
      const map = grid(5);
      const adapter = new ScriptableAdapter(
        [
          { id: "r1", startNodeId: "n0_0" },
          { id: "r2", startNodeId: "n4_4" },
        ],
        map
      );
      const clock = fakeClock();
      const orchestrator = new Orchestrator(map, adapter, {
        now: clock.now,
        offlineGraceMs: 5_000,
      });

      // r1 gets order A's :pick leg.
      const orderA = orchestrator.submitOrder("n2_0", "n4_4");
      step(orchestrator, adapter);
      step(orchestrator, adapter);
      let a = orchestrator.snapshot().orders.find((o) => o.id === orderA.id);
      expect(a?.robotId).toBe("r1");

      // A is requeued away from r1 (offline + grace period) and r2 picks
      // it up instead.
      adapter.setConnection("r1", false);
      orchestrator.tickOnce();
      clock.advance(6_000);
      orchestrator.tickOnce();
      const cancelCallsAfterOfflineTimeout = adapter.cancelCalls.length;
      expect(cancelCallsAfterOfflineTimeout).toBe(1); // the legitimate offline-timeout cancel

      let aTakenByR2 = false;
      for (let i = 0; i < 10 && !aTakenByR2; i++) {
        step(orchestrator, adapter);
        const found = orchestrator.snapshot().orders.find((o) => o.id === orderA.id);
        aTakenByR2 = found?.robotId === "r2";
      }
      expect(aTakenByR2).toBe(true);

      // r1 comes back online and is legitimately dispatched a brand-new
      // order B.
      adapter.setConnection("r1", true);
      orchestrator.tickOnce();

      const orderB = orchestrator.submitOrder("n0_0", "n0_1");
      let bDispatchedToR1 = false;
      for (let i = 0; i < 10 && !bDispatchedToR1; i++) {
        step(orchestrator, adapter);
        const found = orchestrator.snapshot().orders.find((o) => o.id === orderB.id);
        bDispatchedToR1 = found?.status === "dispatched" && found?.robotId === "r1";
      }
      expect(bDispatchedToR1).toBe(true);
      const cancelCallsAtBDispatch = adapter.cancelCalls.length;
      expect(cancelCallsAtBDispatch).toBe(cancelCallsAfterOfflineTimeout); // no cancel from dispatching B

      // Now the stale ack for A's old :pick mission finally arrives from
      // r1 — strictly after r1 was reassigned to B.
      adapter.injectEvent({
        type: "missionDone",
        robotId: "r1",
        missionId: `${orderA.id}:pick`,
      });
      orchestrator.tickOnce();

      expect(
        orchestrator.getAlarms().some((msg) => msg.includes("stale missionDone") && msg.includes("r1"))
      ).toBe(true);

      // The critical assertion: B's live mission must NOT have been
      // canceled, and B must still be bound to r1.
      expect(adapter.cancelCalls.length).toBe(cancelCallsAtBDispatch);
      const bAfterStaleReport = orchestrator.snapshot().orders.find((o) => o.id === orderB.id);
      expect(bAfterStaleReport?.robotId).toBe("r1");
      expect(["dispatched", "underway"]).toContain(bAfterStaleReport?.status);

      // B must complete normally on r1.
      let bCompleted = false;
      for (let i = 0; i < 40 && !bCompleted; i++) {
        step(orchestrator, adapter);
        const found = orchestrator.snapshot().orders.find((o) => o.id === orderB.id);
        bCompleted = found?.status === "completed";
      }
      expect(bCompleted).toBe(true);
      const finalB = orchestrator.snapshot().orders.find((o) => o.id === orderB.id);
      expect(finalB?.robotId).toBe("r1");

      // No cancelMission calls happened beyond the one legitimate
      // offline-timeout cancel for A, across the entire scenario.
      expect(adapter.cancelCalls).toEqual(["r1"]);
    });
  });

  describe("I1: premature missionDone (frontier race)", () => {
    it("(b) genuine early done: rejects a done report that arrives before the robot's known position reaches the leg goal, then recovers via requeue", () => {
      const map = grid(5);
      const adapter = new ScriptableAdapter(
        [
          { id: "r1", startNodeId: "n0_0" },
          { id: "r2", startNodeId: "n4_4" },
        ],
        map
      );
      const clock = fakeClock();
      const orchestrator = new Orchestrator(map, adapter, { now: clock.now });

      // Pickup close to r1, drop far away so there's a wide window between
      // "underway" (pick leg done, drop leg started) and r1 actually
      // reaching the drop node.
      const order = orchestrator.submitOrder("n1_0", "n4_4");

      let underway = false;
      for (let i = 0; i < 10 && !underway; i++) {
        step(orchestrator, adapter);
        const found = orchestrator.snapshot().orders.find((o) => o.id === order.id);
        underway = found?.status === "underway";
      }
      expect(underway).toBe(true);
      const midDrop = orchestrator.snapshot().orders.find((o) => o.id === order.id);
      expect(midDrop?.robotId).toBe("r1");

      const r1Pos = orchestrator.snapshot().robots.find((r) => r.id === "r1")?.pos;
      // Sanity: r1 is nowhere near the drop node (n4_4) yet.
      expect(r1Pos).not.toEqual({ x: 4, y: 4 });

      const cancelCallsBefore = adapter.cancelCalls.length;

      // A real (non-lockstepped) adapter can truthfully report the
      // wire-level mission it most recently sent as fully processed before
      // this robot's LAST KNOWN position has actually caught up to the
      // leg's goal node — see Vda5050Adapter's per-tick incremental
      // extension (only one more base node released per tick). Inject
      // exactly that: a missionDone for the CURRENT (":drop") leg while r1
      // is still far from the goal.
      adapter.injectEvent({
        type: "missionDone",
        robotId: "r1",
        missionId: `${order.id}:drop`,
      });
      orchestrator.tickOnce();

      expect(
        orchestrator
          .getAlarms()
          .some((msg) => msg.includes("premature missionDone") && msg.includes("r1"))
      ).toBe(true);
      // The premature report triggers a best-effort cancel of whatever the
      // robot is (mistakenly) still executing.
      expect(adapter.cancelCalls.length).toBe(cancelCallsBefore + 1);

      const afterPremature = orchestrator.snapshot().orders.find((o) => o.id === order.id);
      // NOT silently accepted as complete — recoverable via requeue instead.
      expect(afterPremature?.status).not.toBe("completed");
      expect(afterPremature?.retries).toBeGreaterThanOrEqual(1);

      // The order recovers and completes normally afterward (whichever
      // robot ends up finishing it).
      let completed = false;
      for (let i = 0; i < 60 && !completed; i++) {
        step(orchestrator, adapter);
        const found = orchestrator.snapshot().orders.find((o) => o.id === order.id);
        completed = found?.status === "completed";
      }
      expect(completed).toBe(true);
    });

    it("(a) same-batch freshness: accepts a done report immediately following a same-batch goal-arrival state event", () => {
      // Regression test for a round-2 review finding: the original I1 fix
      // read rt.currentNodeId, which resolveCurrentNodes() only refreshes
      // ONCE PER TICK, AFTER the whole event-drain loop. When a real
      // adapter's goal-arrival "state" event and the accompanying
      // missionDone land in the SAME drain batch (state first, per FIFO —
      // exactly what Vda5050Adapter produces: handleState emits
      // missionProgress/state from one message, and a closely-following
      // onOrderProcessed(active:false) settlement can queue its
      // missionDone before the next tick drains), the guard used to still
      // see LAST TICK's stale node and misclassify a genuinely on-time
      // completion as premature — reproduced as integration-test flakiness
      // (2 failures in 5 runs, one driving an order to permanent "failed"
      // via 3 false requeues). Fixed by updating rt.currentNodeId INLINE
      // as each event in the batch is handled (see handleEvent's "state"
      // case), not just once at the end of the tick.
      const map = grid(5);
      const adapter = new ScriptableAdapter(
        [
          { id: "r1", startNodeId: "n0_0" },
          { id: "r2", startNodeId: "n4_4" },
        ],
        map
      );
      const clock = fakeClock();
      const orchestrator = new Orchestrator(map, adapter, { now: clock.now });

      const order = orchestrator.submitOrder("n1_0", "n4_4");

      let underway = false;
      for (let i = 0; i < 10 && !underway; i++) {
        step(orchestrator, adapter);
        const found = orchestrator.snapshot().orders.find((o) => o.id === order.id);
        underway = found?.status === "underway";
      }
      expect(underway).toBe(true);

      const beforeState = orchestrator.snapshot().robots.find((r) => r.id === "r1");
      expect(beforeState).toBeDefined();

      // Fabricate the same-batch sequence: a state event showing r1 has
      // physically arrived at the leg's goal node, immediately followed —
      // same tick's drain batch, no tickOnce() call in between — by the
      // corresponding missionDone.
      const goalPos = map.node("n4_4").pos;
      adapter.injectEvent({
        type: "state",
        state: { ...beforeState!, pos: goalPos, status: "EXECUTING" },
      });
      adapter.injectEvent({
        type: "missionDone",
        robotId: "r1",
        missionId: `${order.id}:drop`,
      });
      orchestrator.tickOnce();

      expect(orchestrator.getAlarms().some((a) => a.includes("premature missionDone"))).toBe(false);
      const afterOrder = orchestrator.snapshot().orders.find((o) => o.id === order.id);
      expect(afterOrder?.status).toBe("completed");
    });

    it("accepts a done report via authoritative lastVdaNodeId even when a same-batch state event's position snap disagrees", () => {
      // The state event's positional snap and a missionProgress event's
      // VDA lastNodeId both derive from the same underlying AGV message,
      // but the snap can occasionally lag. This verifies the independent
      // rt.lastVdaNodeId signal (persisted, untouched by the "state"
      // handler's snap recompute) alone is enough to accept the done —
      // "lastNodeId beats snap" — even if a same-batch state event still
      // reports the OLD position.
      const map = grid(5);
      const adapter = new ScriptableAdapter(
        [
          { id: "r1", startNodeId: "n0_0" },
          { id: "r2", startNodeId: "n4_4" },
        ],
        map
      );
      const clock = fakeClock();
      const orchestrator = new Orchestrator(map, adapter, { now: clock.now });

      const order = orchestrator.submitOrder("n1_0", "n4_4");

      let underway = false;
      for (let i = 0; i < 10 && !underway; i++) {
        step(orchestrator, adapter);
        const found = orchestrator.snapshot().orders.find((o) => o.id === order.id);
        underway = found?.status === "underway";
      }
      expect(underway).toBe(true);

      const staleState = orchestrator.snapshot().robots.find((r) => r.id === "r1");
      expect(staleState).toBeDefined();
      // Sanity: r1's actual last-known position is NOT the goal.
      expect(staleState?.pos).not.toEqual(map.node("n4_4").pos);

      adapter.injectEvent({
        type: "missionProgress",
        robotId: "r1",
        missionId: `${order.id}:drop`,
        lastNodeId: "n4_4",
      });
      // A lagging state snapshot arriving right after, in the SAME batch,
      // still reporting the OLD (stale) position — must NOT regress the
      // guard's decision away from what missionProgress just confirmed.
      adapter.injectEvent({
        type: "state",
        state: { ...staleState!, status: "EXECUTING" },
      });
      adapter.injectEvent({
        type: "missionDone",
        robotId: "r1",
        missionId: `${order.id}:drop`,
      });
      orchestrator.tickOnce();

      expect(orchestrator.getAlarms().some((a) => a.includes("premature missionDone"))).toBe(false);
      const afterOrder = orchestrator.snapshot().orders.find((o) => o.id === order.id);
      expect(afterOrder?.status).toBe("completed");
    });
  });

  describe("round-3 regression: re-quarantine after later drift off-grid", () => {
    it("quarantines a robot that resolved once and later reports an unresolvable position", () => {
      // Regression test for a round-3 review finding: the batch-freshness
      // fix (I1) made resolveCurrentNodes() treat an already-set
      // rt.currentNodeId as sticky ("resolved this batch, don't
      // re-derive"), but the "state" event handler only assigned a FRESH
      // snap result when it resolved to a valid node — on an unresolvable
      // snap it left the old (stale, still-valid-looking) node id in
      // place. A robot that resolved once and later genuinely drifted
      // off-grid would keep that stale valid node forever and never get
      // quarantined. Fixed by always assigning the snap result in the
      // "state" handler, including `undefined`.
      const map = grid(3);
      const adapter = new ScriptableAdapter([{ id: "r1", startNodeId: "n0_0" }], map);
      const clock = fakeClock();
      const orchestrator = new Orchestrator(map, adapter, { now: clock.now });

      // Tick 1: normal heartbeat at a valid node — resolves fine, no
      // quarantine.
      adapter.tick();
      orchestrator.tickOnce();
      const afterTick1 = orchestrator.snapshot().robots.find((r) => r.id === "r1");
      expect(afterTick1).toBeDefined();
      expect(afterTick1?.status).not.toBe("ERROR");
      expect(orchestrator.getAlarms().some((a) => a.includes("quarantined"))).toBe(false);

      // Tick 2: the robot reports an off-grid position — nothing in the
      // map resolves to it.
      adapter.injectEvent({
        type: "state",
        state: { ...afterTick1!, pos: { x: 99, y: 99 } },
      });
      orchestrator.tickOnce();

      const afterTick2 = orchestrator.snapshot().robots.find((r) => r.id === "r1");
      expect(afterTick2?.status).toBe("ERROR");
      expect(
        orchestrator.getAlarms().some((a) => a.includes("quarantined") && a.includes("r1"))
      ).toBe(true);
    });
  });

  describe("round-3 regression: lastVdaNodeId does not leak across legs", () => {
    it("does not let a stale VDA lastNodeId from a completed leg wrongly satisfy a different leg's premature-done guard", () => {
      // Regression test for a round-3 review finding: rt.lastVdaNodeId was
      // written by missionProgress events but never reset, so a value
      // confirmed for a PREVIOUS leg persisted indefinitely. If a LATER,
      // unrelated leg's goal node happened to coincide with that stale
      // value, handleMissionDone's frontier-race guard would wrongly
      // accept a premature "done" for the new leg even though the robot
      // hadn't made any progress on it. Fixed by routing every rt.leg
      // assignment/clear through a setLeg() helper that also resets
      // rt.lastVdaNodeId.
      //
      // Fully scripted (not relying on organic step()-driven movement for
      // the critical portion): a real, organically-simulated journey
      // naturally overwrites rt.lastVdaNodeId with fresh, LEGITIMATE
      // missionProgress along the way — which would dilute the exact
      // coincidence being tested before it could ever manifest. Scripting
      // it directly reproduces the review's precise repro: "A drops at
      // n2_2, B targets n2_2, robot at n0_1, early done for B".
      const map = grid(5);
      const adapter = new ScriptableAdapter([{ id: "r1", startNodeId: "n0_0" }], map);
      const clock = fakeClock();
      const orchestrator = new Orchestrator(map, adapter, { now: clock.now });

      const orderA = orchestrator.submitOrder("n1_0", "n2_2");
      let aUnderway = false;
      for (let i = 0; i < 20 && !aUnderway; i++) {
        step(orchestrator, adapter);
        const found = orchestrator.snapshot().orders.find((o) => o.id === orderA.id);
        aUnderway = found?.status === "underway";
      }
      expect(aUnderway).toBe(true);

      // Script A's drop leg reaching its goal directly: a missionProgress
      // confirming n2_2 (setting rt.lastVdaNodeId = "n2_2"), then the
      // matching missionDone — a legitimate completion by the guard's own
      // rules.
      adapter.injectEvent({
        type: "missionProgress",
        robotId: "r1",
        missionId: `${orderA.id}:drop`,
        lastNodeId: "n2_2",
      });
      adapter.injectEvent({
        type: "missionDone",
        robotId: "r1",
        missionId: `${orderA.id}:drop`,
      });
      orchestrator.tickOnce();
      const afterA = orchestrator.snapshot().orders.find((o) => o.id === orderA.id);
      expect(afterA?.status).toBe("completed");

      // Order B also drops at n2_2 — the SAME node A just legitimately
      // reached. Single-robot fleet forces it onto r1 too.
      const orderB = orchestrator.submitOrder("n0_1", "n2_2");
      orchestrator.tickOnce(); // dispatch assigns B's pick leg to the now-idle r1
      const dispatched = orchestrator.snapshot().orders.find((o) => o.id === orderB.id);
      expect(dispatched?.status).toBe("dispatched");
      expect(dispatched?.robotId).toBe("r1");

      // Script B's pick leg completing WITHOUT any missionProgress event —
      // a legitimate possibility (e.g. a short pick leg), and exactly the
      // case where, pre-fix, nothing would have overwritten A's stale
      // "n2_2" left in rt.lastVdaNodeId.
      const r1Now = orchestrator.snapshot().robots.find((r) => r.id === "r1")!;
      adapter.injectEvent({
        type: "state",
        state: { ...r1Now, pos: map.node("n0_1").pos },
      });
      adapter.injectEvent({
        type: "missionDone",
        robotId: "r1",
        missionId: `${orderB.id}:pick`,
      });
      orchestrator.tickOnce();
      const afterPick = orchestrator.snapshot().orders.find((o) => o.id === orderB.id);
      expect(afterPick?.status).toBe("underway");

      // B's drop leg is now active (goalNode = n2_2, coinciding with A's
      // old goal). Report the robot's actual position as demonstrably
      // elsewhere (n0_1, matching the review's repro) — no
      // missionProgress for this leg — then inject a premature done.
      // Without the leg-scoped reset, the stale rt.lastVdaNodeId === "n2_2"
      // left over from A's drop leg would wrongly satisfy the guard and
      // this would be silently accepted as a legitimate completion.
      const r1AtPickup = orchestrator.snapshot().robots.find((r) => r.id === "r1")!;
      expect(r1AtPickup.pos).toEqual(map.node("n0_1").pos);
      adapter.injectEvent({
        type: "state",
        state: { ...r1AtPickup, pos: map.node("n0_1").pos },
      });
      adapter.injectEvent({
        type: "missionDone",
        robotId: "r1",
        missionId: `${orderB.id}:drop`,
      });
      orchestrator.tickOnce();

      expect(
        orchestrator.getAlarms().some((a) => a.includes("premature missionDone") && a.includes("r1"))
      ).toBe(true);
      const afterEarlyDone = orchestrator.snapshot().orders.find((o) => o.id === orderB.id);
      expect(afterEarlyDone?.status).not.toBe("completed");
      expect(afterEarlyDone?.retries).toBeGreaterThanOrEqual(1);
    });
  });
});
