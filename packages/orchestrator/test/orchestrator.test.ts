import { describe, it, expect } from "vitest";
import { WarehouseMap } from "@tez/core";
import { FakeAdapter } from "@tez/robot-interface";
import type { AdapterEvent, Mission } from "@tez/robot-interface";
import type { RobotId, RobotState, CellKey } from "@tez/shared";
import { cellKey } from "@tez/shared";
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

      // The order must complete — via r2 (its legitimate holder) in the
      // common case, but Task 2's reservation-blocking fix means r1's own
      // stale, uncancellable FakeAdapter mission keeps physically walking
      // it (see the class comment above on UncancellableFakeAdapter) all
      // the way to n2_0 — the order's OWN pickup node — where it then
      // parks as a genuinely idle (no-leg) robot and, per
      // resolveCurrentNodes()'s "idle robots own their current cell" rule,
      // permanently reserves that exact cell. That can legitimately block
      // r2's fresh pick leg from ever claiming n2_0, in which case the
      // deadlock backstop / premature-missionDone requeue correctly hands
      // the order back to r1 — which, being physically parked right on the
      // pickup, then finishes it immediately. Either outcome is a
      // correctly-functioning system; what this test guards is that the
      // EARLIER stale report (asserted above) never itself corrupted or
      // silently completed the order — so accept either robot here.
      let completed = false;
      for (let i = 0; i < 40 && !completed; i++) {
        step(orchestrator, adapter);
        const snap = orchestrator.snapshot();
        const found = snap.orders.find((o) => o.id === order.id);
        completed = found?.status === "completed";
      }
      expect(completed).toBe(true);
      const finalOrder = orchestrator.snapshot().orders.find((o) => o.id === order.id);
      expect(["r1", "r2"]).toContain(finalOrder?.robotId);

      // The fleet must still be fully functional afterward — dispatch is
      // not permanently wedged for either robot by anything that happened
      // above. (Not asserting WHICH robot: the order-1 resolution above
      // may have physically relocated either robot away from its original
      // corner, so "closest to a fresh order near n0_0" is no longer
      // pinned to r1 specifically.)
      const order2 = orchestrator.submitOrder("n0_0", "n0_1");
      let order2Dispatched = false;
      for (let i = 0; i < 10 && !order2Dispatched; i++) {
        adapter.tick();
        orchestrator.tickOnce();
        const found2 = orchestrator.snapshot().orders.find((o) => o.id === order2.id);
        order2Dispatched = found2?.status === "dispatched";
      }
      expect(order2Dispatched).toBe(true);
      const order2State = orchestrator.snapshot().orders.find((o) => o.id === order2.id);
      expect(["r1", "r2"]).toContain(order2State?.robotId);
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
      // Small blockedTicksLimit: with the frontier-race resume fix
      // (handleMissionDone no longer misfires "premature missionDone" as a
      // fast-but-wrong side-channel deadlock detector — see the note
      // below), the ONLY thing that now detects r2's permanently-blocked
      // return route is the deadlock backstop itself, which takes
      // opts.blockedTicksLimit consecutive blocked ticks to fire, up to 3
      // times (one per requeue). Keep it small so this test's fixed
      // iteration budget below comfortably covers all 3 cycles.
      const orchestrator = new Orchestrator(map, adapter, {
        now: clock.now,
        offlineGraceMs: 5_000,
        blockedTicksLimit: 5,
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

      // Task 2 note: under strict, reservation-blocking extension (fixing
      // the old advisory-claims defect), r1 — offline and never revived —
      // is frozen forever at whatever cell it physically occupied the
      // instant it went offline, and (per resolveCurrentNodes()'s "idle
      // robots own their current cell" rule) permanently reserves that
      // cell. In THIS map (pickup n1_0, drop n4_4, r1 starting at n0_0 —
      // collinear with both), that frozen cell sits squarely on r2's own
      // return route back to the pickup, with only 2 robots in the fleet
      // and no third robot to route around it. r2's fresh :pick leg can
      // never claim its way to n1_0, so — exactly as documented on
      // Orchestrator's class JSDoc as the accepted parked-robot-blocks
      // -the-only-path limitation — the order legitimately exhausts its 3
      // requeue attempts and reaches "failed" rather than hanging forever.
      // This is the correct, intended outcome, not a stuck fleet: verify
      // it reaches a definite terminal state instead of the old "always
      // eventually completes" expectation, which relied on the
      // now-fixed advisory-reservations defect (claims never actually
      // blocked a send). Detection mechanism: handleMissionDone's
      // frontier-race guard correctly resumes (not cancel+requeues) every
      // time r2's short, un-extendable committed mission completes at its
      // own frontier short of n1_0 — it is NOT a fast-path deadlock
      // detector (fixing that misclassification was itself a Task 2 fix
      // round). The ONLY thing that ever detects this permanent block is
      // the deadlock backstop (opts.blockedTicksLimit consecutive blocked
      // routing ticks), once per requeue cycle, up to 3 times — hence the
      // larger iteration budget and the small blockedTicksLimit above.
      let terminal = false;
      for (let i = 0; i < 150 && !terminal; i++) {
        step(orchestrator, adapter);
        const found = orchestrator.snapshot().orders.find((o) => o.id === order.id);
        terminal = found?.status === "completed" || found?.status === "failed";
      }
      expect(terminal).toBe(true);

      const finalOrder = orchestrator.snapshot().orders.find((o) => o.id === order.id);
      expect(finalOrder?.status).toBe("failed");
      expect(finalOrder?.retries).toBe(3);
      // robotId is retained for audit trail on the terminal "failed"
      // state (OrderBook semantics) — still r2, its last assignee.
      expect(finalOrder?.robotId).toBe("r2");
      const pickTransitions = finalOrder?.history.filter(
        (h) => h.from === "dispatched" && h.to === "underway"
      );
      // Only r1's original pickup ever completed; r2's own :pick leg is
      // the one permanently blocked by r1's frozen, reservation-owned
      // cell, so it never itself reaches "underway".
      expect(pickTransitions).toHaveLength(1);
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
      // r2 parks at n0_4 (not n4_4, the order's own drop node) for this
      // test specifically: Task 2's reservation-blocking fix means an
      // idle, leg-less robot permanently owns its current cell (see
      // resolveCurrentNodes()), and this test's "recovers via requeue"
      // assertion below needs r1 to genuinely be able to complete the
      // drop after the premature-done requeue — which it cannot do if r2
      // is parked forever exactly on r1's own destination.
      const adapter = new ScriptableAdapter(
        [
          { id: "r1", startNodeId: "n0_0" },
          { id: "r2", startNodeId: "n0_4" },
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

    it("(d) committed-path-complete resume: a robot that outruns its horizon-capped mission resumes instead of getting requeued", () => {
      // Regression test for a real Task 2 defect caught by the sim e2e
      // soak (Task 3): under horizon-gated extension, the orchestrator can
      // deliberately send a mission SHORTER than the leg's true goal
      // (paused by opts.horizon), and when the robot's telemetry arrives
      // faster than orchestrator ticks — exactly what a real adapter's
      // wall-clock cadence produces, simulated here by running several
      // adapter.tick() calls with no intervening orch.tickOnce() — the
      // robot can fully drain that short committed mission and the
      // adapter truthfully reports it "done" well before the leg's actual
      // goal. Pre-fix, the frontier-race guard misclassified this as a
      // genuine premature/corrupt report and cancelled + requeued the
      // order every time this happened, exhausting OrderBook's 3-retry
      // cap and failing orders that were never actually blocked — just
      // paced by the horizon. The fix: when the robot's batch-fresh node
      // is exactly the committed FRONTIER (not short of it), resume
      // instead of requeue.
      const map = WarehouseMap.fromJSON(WarehouseMap.grid(15, 15));
      const adapter = new FakeAdapter([{ id: "r1", startNodeId: "n0_0" }], map);
      const orchestrator = new Orchestrator(map, adapter, { horizon: 3 });
      adapter.tick();
      orchestrator.tickOnce();
      const order = orchestrator.submitOrder("n14_0", "n0_0");

      // Let the pick leg extend up to the horizon cap.
      for (let i = 0; i < 6; i++) {
        step(orchestrator, adapter);
      }
      const beforeRace = orchestrator.snapshot().orders.find((o) => o.id === order.id);
      expect(beforeRace?.status).toBe("dispatched");
      expect(beforeRace?.retries).toBe(0);

      // Race the robot ahead of the orchestrator: several physical ticks
      // accumulate in the event queue with no orchestrator tick in
      // between, so the robot fully drains its horizon-capped committed
      // mission (and the adapter fires missionDone for it) before
      // runRouting() ever gets a chance to extend it further — repeated a
      // few times to also exercise it past the pick->drop transition.
      for (let cycle = 0; cycle < 6; cycle++) {
        for (let i = 0; i < 5; i++) adapter.tick();
        orchestrator.tickOnce();
      }

      let completed = false;
      for (let i = 0; i < 200 && !completed; i++) {
        step(orchestrator, adapter);
        completed = orchestrator.snapshot().orders.find((o) => o.id === order.id)?.status === "completed";
      }
      expect(completed).toBe(true);

      const finalOrder = orchestrator.snapshot().orders.find((o) => o.id === order.id);
      // No requeue ever happened: the order was never blocked, only paced
      // by the horizon, and the fix must never mistake that for a genuine
      // frontier race.
      expect(finalOrder?.retries).toBe(0);
      expect(orchestrator.getAlarms().some((a) => a.includes("premature missionDone"))).toBe(false);
      expect(orchestrator.getAlarms().some((a) => a.includes("resuming, not requeueing"))).toBe(true);
    });

    it("(e) committed-path-complete resume via authoritative lastVdaNodeId, even when a stale state event's position snap disagrees", () => {
      // Regression test for a fix-round-3 review finding on test (d)'s own
      // fix: atFrontier originally checked ONLY rt.currentNodeId, mirroring
      // neither reachedGoal's dual-signal check three lines above it nor
      // test (c)'s own precedent (accepting a done report via authoritative
      // lastVdaNodeId even when a same-batch state event's snap disagrees).
      // Under a real Vda5050Adapter, the AGV's own reported lastNodeId can
      // reach the FRONTIER a full batch ahead of the position-snap-derived
      // currentNodeId (see RobotRuntime.lastVdaNodeId's doc comment) —
      // checking currentNodeId alone would then spuriously read "not at
      // frontier" and misroute a legitimately-finished robot into the
      // genuine-premature cancel+requeue branch: a narrower reintroduction
      // of this same class of regression, gated on signal arrival order
      // instead of horizon/contention pacing. FakeAdapter's own tick()-
      // driven simulation can never exercise this (missionProgress for the
      // frontier always precedes missionDone by a full tick there), so this
      // uses ScriptableAdapter.injectEvent to construct the race directly:
      // inject missionProgress confirming the frontier (sets both
      // rt.lastVdaNodeId AND rt.currentNodeId, per handleEvent's
      // "missionProgress" case), then a stale "state" event reporting the
      // PREVIOUS node (the "state" handler unconditionally re-derives
      // currentNodeId from the reported pos, regressing it behind
      // lastVdaNodeId — exactly test (c)'s own technique), then missionDone.
      const map = grid(5);
      const adapter = new ScriptableAdapter([{ id: "r1", startNodeId: "n0_0" }], map);
      // Small horizon so the pick leg's frontier caps well short of the
      // pickup goal (n0_0 -> n1_0 -> n2_0, horizon 2, goal n4_0).
      const orchestrator = new Orchestrator(map, adapter, { horizon: 2 });
      adapter.tick();
      orchestrator.tickOnce();
      const order = orchestrator.submitOrder("n4_0", "n0_0");

      // Dispatch + first extension attempt(s).
      orchestrator.tickOnce();
      // One physical step: robot moves to n1_0, one behind the n2_0
      // frontier the extension already committed to.
      step(orchestrator, adapter);
      const r1 = orchestrator.snapshot().robots.find((r) => r.id === "r1");
      expect(r1?.pos).toEqual(map.node("n1_0").pos);

      const missionId = `${order.id}:pick`;
      adapter.injectEvent({
        type: "missionProgress",
        robotId: "r1",
        missionId,
        lastNodeId: "n2_0",
      });
      adapter.injectEvent({
        type: "state",
        state: { ...r1!, pos: map.node("n1_0").pos, status: "EXECUTING" },
      });
      adapter.injectEvent({ type: "missionDone", robotId: "r1", missionId });
      orchestrator.tickOnce();

      // Core assertion: the race resumes, it does NOT requeue.
      expect(orchestrator.getAlarms().some((a) => a.includes("premature missionDone"))).toBe(false);
      expect(orchestrator.getAlarms().some((a) => a.includes("resuming, not requeueing"))).toBe(true);
      const afterRace = orchestrator.snapshot().orders.find((o) => o.id === order.id);
      expect(afterRace?.retries).toBe(0);
      expect(afterRace?.status).toBe("dispatched");

      // Deliberately narrowly scoped, per the review finding's own
      // guidance: NOT continuing to drive this to full completion.
      // ScriptableAdapter.injectEvent fabricates the missionDone directly
      // at the orchestrator boundary, bypassing FakeAdapter's OWN internal
      // mission bookkeeping entirely (unlike a genuine completion, which
      // always goes through FakeAdapter's own tick()-driven
      // currentNodeIndex/mission-clearing logic) — FakeAdapter's
      // internal robot.mission is left tracking the ORIGINAL 3-node
      // mission, unaware the orchestrator now believes it "done". Driving
      // further step()s lets that stale internal mission keep physically
      // completing on its own terms and re-fire a SECOND, genuinely
      // conflicting missionDone for the same missionId once the
      // orchestrator's OWN subsequent extension has already moved the
      // frontier past where this second report arrives — a real
      // double-completion race, but one purely of THIS TEST's
      // construction (a real Vda5050Adapter's `this.orders.delete()`
      // happens synchronously before its single `missionDone` emission,
      // so it can never double-report the same wire order). Continuing
      // this test's own physical simulation past the injected race would
      // therefore be testing an artifact of the injection technique, not
      // the fix.
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

  function spyMissions(adapter: FakeAdapter): Array<{ robotId: string; id: string; nodeIds: string[] }> {
    const sent: Array<{ robotId: string; id: string; nodeIds: string[] }> = [];
    const orig = adapter.sendMission.bind(adapter);
    adapter.sendMission = async (m, map) => {
      sent.push({ robotId: m.robotId as string, id: m.id, nodeIds: [...m.nodeIds] });
      return orig(m, map);
    };
    return sent;
  }

  describe("P0: horizon-gated, reservation-blocked extension", () => {
    it("stops extending when the robot lags horizon nodes behind the frontier", () => {
      const map = WarehouseMap.fromJSON(WarehouseMap.grid(12, 1));
      const adapter = new FakeAdapter([{ id: "r1" as RobotId, startNodeId: "n0_0" }], map);
      const sent = spyMissions(adapter);
      const orch = new Orchestrator(map, adapter, { horizon: 3 });
      adapter.tick(); // seed state event
      orch.tickOnce(); // registers robot
      orch.submitOrder("n11_0", "n0_0");
      // Drive many orchestrator ticks WITHOUT letting the robot move:
      for (let i = 0; i < 15; i++) orch.tickOnce();
      const last = sent[sent.length - 1]!;
      // Robot never moved from n0_0 (progressIndex 0) => frontier may be at
      // most `horizon` nodes ahead => path length at most 1 + 3.
      expect(last.nodeIds.length).toBeLessThanOrEqual(4);
      // And extension resumes once the robot catches up:
      for (let i = 0; i < 3; i++) { adapter.tick(); orch.tickOnce(); }
      const after = sent[sent.length - 1]!;
      expect(after.nodeIds.length).toBeGreaterThan(last.nodeIds.length);
    });

    it("every sent path is a chain of adjacent nodes", () => {
      const map = WarehouseMap.fromJSON(WarehouseMap.grid(6, 6));
      const adapter = new FakeAdapter(
        [
          { id: "r1" as RobotId, startNodeId: "n0_0" },
          { id: "r2" as RobotId, startNodeId: "n5_5" },
        ],
        map
      );
      const sent = spyMissions(adapter);
      const orch = new Orchestrator(map, adapter, { horizon: 5 });
      adapter.tick();
      orch.tickOnce();
      orch.submitOrder("n5_0", "n0_5");
      orch.submitOrder("n0_5", "n5_0");
      // Skewed cadence: adapter advances only every 2nd orchestrator tick.
      for (let i = 0; i < 80; i++) {
        if (i % 2 === 0) adapter.tick();
        orch.tickOnce();
      }
      for (const m of sent) {
        for (let i = 1; i < m.nodeIds.length; i++) {
          expect(
            map.neighbors(m.nodeIds[i - 1]!).includes(m.nodeIds[i]!),
            `${m.robotId} ${m.id}: ${m.nodeIds[i - 1]} -> ${m.nodeIds[i]} not adjacent`
          ).toBe(true);
        }
      }
    });

    it("two robots' committed windows never overlap a cell (skewed cadence)", () => {
      const map = WarehouseMap.fromJSON(WarehouseMap.grid(6, 6));
      const adapter = new FakeAdapter(
        [
          { id: "r1" as RobotId, startNodeId: "n0_0" },
          { id: "r2" as RobotId, startNodeId: "n5_0" },
        ],
        map
      );
      const sent = spyMissions(adapter);
      const orch = new Orchestrator(map, adapter, { horizon: 5 });
      adapter.tick();
      orch.tickOnce();
      // Crossing routes along the same row
      orch.submitOrder("n5_0", "n5_5"); // likely r1: crosses toward x=5
      orch.submitOrder("n0_0", "n0_5"); // likely r2: crosses toward x=0
      const latestByRobot = new Map<string, string[]>();
      for (let i = 0; i < 120; i++) {
        if (i % 3 !== 0) adapter.tick(); // robots run FASTER than planner some ticks, slower others
        orch.tickOnce();
        for (const m of sent.splice(0)) latestByRobot.set(m.robotId, m.nodeIds);
        // committed windows = suffix of each latest path from the robot's
        // current node onward; they must be cell-disjoint between robots.
        const windows: Array<Set<string>> = [];
        for (const [rid, nodeIds] of latestByRobot) {
          const state = adapter.robots().find((r) => r.id === rid)!;
          const curKey = `${state.pos.x},${state.pos.y}`;
          const idx = nodeIds.findIndex((n) => {
            const p = map.node(n).pos;
            return `${p.x},${p.y}` === curKey;
          });
          const from = idx === -1 ? 0 : idx;
          windows.push(new Set(nodeIds.slice(from)));
        }
        if (windows.length === 2) {
          for (const cell of windows[0]!) {
            expect(windows[1]!.has(cell), `tick ${i}: shared cell ${cell}`).toBe(false);
          }
        }
      }
    });

    it("sustained reservation contention requeues the order (deadlock backstop)", () => {
      // 3x1 corridor: r2 is idle and parked mid-corridor; r1's only path to
      // the pickup runs through it. The order must never hang: it gets
      // requeued repeatedly and, after exhausting OrderBook's 3-retry cap,
      // reaches "failed" — never stuck non-terminal forever.
      //
      // Note: r2 (n1_0) is closer to the pickup (n2_0) than r1 (n0_0), so
      // dispatch's Hungarian assignment will actually hand the order to r2,
      // not r1 — leaving r1 parked at n0_0 instead. This still exercises
      // the exact same deadlock: r2's drop leg (n2_0 -> n0_0) must pass
      // through n1_0 (which it vacates as it moves) and then n0_0, which
      // r1 permanently owns as a parked idle robot. Either direction of
      // assignment deadlocks on the other robot's parked cell — the known
      // accepted limitation documented on the class — so no pinning is
      // needed for this assertion to hold.
      //
      // Mechanism note: an idle, leg-less robot is registered as a
      // stationary PIBT agent (`at === goal === currentNode`) every tick
      // (see runRouting()), so PIBT's own pre-existing collision avoidance
      // (hardened in Task 1) already refuses to propose the blocked robot
      // stepping onto that cell — it resolves to "stay". runRouting()'s
      // "no forward candidate" sub-case (review finding 2) counts that as
      // a blocked tick too, so blockedTicks can actually accumulate here.
      //
      // Tick-driving strategy: pairing adapter.tick() with every
      // orch.tickOnce() call (as most of this suite does) races the
      // deadlock backstop against the PRE-EXISTING premature-missionDone
      // guard — the already-sent (but never further-extended, since it's
      // blocked) short mission finishes at its own frontier via
      // FakeAdapter's own tick()-driven progression within about 1 tick of
      // becoming blocked, well before blockedTicks can climb anywhere near
      // the limit, so pairing every tick would pin the WRONG mechanism.
      // Instead: pair ticks only while the order is NOT "underway" (the
      // pick leg and any post-requeue re-pick genuinely need physical
      // movement to complete), and drive orchestrator-only ticks (no
      // adapter.tick()) once "underway" — so the robot never physically
      // catches up to finish its stale short mission early, and
      // blockedTicks is free to climb to the limit via the backstop.
      const map = WarehouseMap.fromJSON(WarehouseMap.grid(3, 1));
      const adapter = new FakeAdapter(
        [
          { id: "r1" as RobotId, startNodeId: "n0_0" },
          { id: "r2" as RobotId, startNodeId: "n1_0" },
        ],
        map
      );
      const orch = new Orchestrator(map, adapter, { horizon: 3, blockedTicksLimit: 3 });
      adapter.tick();
      orch.tickOnce();
      const order = orch.submitOrder("n2_0", "n0_0");
      let terminal = false;
      for (let i = 0; i < 200 && !terminal; i++) {
        const status = orch.snapshot().orders.find((o) => o.id === order.id)?.status;
        if (status === "underway") {
          orch.tickOnce();
        } else {
          adapter.tick();
          orch.tickOnce();
        }
        terminal = orch.snapshot().orders.find((o) => o.id === order.id)?.status === "failed";
      }
      const snap = orch.snapshot();
      const o = snap.orders.find((x) => x.id === order.id)!;
      expect(o.status).toBe("failed");
      expect(o.retries).toBe(3);
      // Pins the backstop mechanism specifically (not the pre-existing
      // premature-missionDone guard, which this tick strategy avoids
      // racing): exactly 3 backstop firings, one per retry, and zero
      // premature-missionDone cancellations.
      const backstopAlarms = orch.getAlarms().filter((a) => a.includes("— requeueing order"));
      expect(backstopAlarms).toHaveLength(3);
      expect(orch.getAlarms().some((a) => a.includes("premature missionDone"))).toBe(false);
    });

    it("deadlock backstop re-claims the blocked robot's own cell (no collision hole)", () => {
      // Direct regression test for review finding 1 (Critical): releaseAll()
      // alone would leave the robot's own physically-occupied cell unowned
      // for the rest of this tick's runRouting() loop and, on the NEXT
      // tick, resolveCurrentNodes()'s idle re-claim would see it as
      // (wrongly) foreign-owned and never recover it. Verifies the fix two
      // ways: (a) directly, via the _reservationOwner() test hook, that the
      // robot's TRUE physical cell is owned by itself immediately after the
      // backstop fires; (b) behaviorally, that no other robot's sent
      // mission ever contains that cell afterward.
      const map = WarehouseMap.fromJSON(WarehouseMap.grid(3, 1));
      const adapter = new FakeAdapter(
        [
          { id: "r1" as RobotId, startNodeId: "n0_0" },
          { id: "r2" as RobotId, startNodeId: "n1_0" },
        ],
        map
      );
      const sent = spyMissions(adapter);
      const orch = new Orchestrator(map, adapter, { horizon: 3, blockedTicksLimit: 3 });
      adapter.tick();
      orch.tickOnce();
      const order = orch.submitOrder("n2_0", "n0_0");

      let underway = false;
      for (let i = 0; i < 20 && !underway; i++) {
        adapter.tick();
        orch.tickOnce();
        underway = orch.snapshot().orders.find((o) => o.id === order.id)?.status === "underway";
      }
      expect(underway).toBe(true);

      let backstopFired = false;
      for (let i = 0; i < 20 && !backstopFired; i++) {
        orch.tickOnce(); // orchestrator-only: see tick-strategy note above
        backstopFired = orch.getAlarms().some((a) => a.includes("— requeueing order"));
      }
      expect(backstopFired).toBe(true);
      expect(orch.snapshot().orders.find((o) => o.id === order.id)?.status).toBe("queued");

      // (a) r2's TRUE physical position (not its stuck frontier — the
      // committed-but-untraversed cells ahead of it are correctly released,
      // only the cell it is actually SITTING on must be re-claimed) is
      // owned by r2 itself, immediately, same tick.
      const r2Pos = orch.snapshot().robots.find((r) => r.id === "r2")?.pos;
      expect(r2Pos).toBeDefined();
      const r2Cell = cellKey(r2Pos!);
      expect(orch._reservationOwner(r2Cell)).toBe("r2");

      // (b) drive the rest of the scenario (further requeue/redispatch
      // cycles) and confirm no OTHER robot's sent mission ever routes
      // through r2's cell — the only other robot here (r1) never gets a
      // leg at all in this scenario, so this also confirms r1 stays
      // correctly excluded from ever being routed through it.
      for (let i = 0; i < 60; i++) {
        const status = orch.snapshot().orders.find((o) => o.id === order.id)?.status;
        if (status === "underway") orch.tickOnce();
        else {
          adapter.tick();
          orch.tickOnce();
        }
      }
      for (const m of sent) {
        if (m.robotId === "r2") continue;
        for (const n of m.nodeIds) {
          expect(
            cellKey(map.node(n).pos),
            `${m.robotId} ${m.id} routed through r2's cell ${r2Cell}`
          ).not.toBe(r2Cell);
        }
      }
    });

    it("offline-timeout re-claims the frozen robot's own cell (no collision hole)", () => {
      // Direct regression test for the final whole-branch review's finding
      // 1 (Important): handleOfflineTimeouts() was the last remaining
      // releaseAll() path with no own-cell re-claim, AND it runs at
      // pipeline step 3 — AFTER resolveCurrentNodes() (step 2) already ran
      // this tick — so nothing heals it before runDispatch/runRouting
      // (steps 4-5) run later this SAME tick, unlike releaseAll() calls
      // during event draining (step 1), which resolveCurrentNodes()
      // immediately re-claims for. Cloned from the deadlock-backstop
      // collision-hole test's shape (requeueBlockedLeg's own regression
      // test above): (a) directly, via _reservationOwner(), that the
      // offline robot's TRUE physical cell is owned by itself immediately
      // after the offline timeout fires, same tick; (b) behaviorally, that
      // no OTHER robot's sent mission ever contains that cell afterward.
      const map = WarehouseMap.fromJSON(WarehouseMap.grid(3, 1));
      const adapter = new FakeAdapter(
        [
          { id: "r1" as RobotId, startNodeId: "n0_0" },
          { id: "r2" as RobotId, startNodeId: "n2_0" },
        ],
        map
      );
      const sent = spyMissions(adapter);
      const clock = fakeClock();
      const orch = new Orchestrator(map, adapter, { now: clock.now, offlineGraceMs: 5_000 });
      adapter.tick();
      orch.tickOnce();

      // r1 gets a short hop toward the corridor middle so it has somewhere
      // to physically freeze other than its own start cell.
      const order = orch.submitOrder("n1_0", "n0_0");
      let underway = false;
      for (let i = 0; i < 10 && !underway; i++) {
        adapter.tick();
        orch.tickOnce();
        underway = orch.snapshot().orders.find((o) => o.id === order.id)?.status === "underway";
      }
      expect(underway).toBe(true);
      expect(orch.snapshot().orders.find((o) => o.id === order.id)?.robotId).toBe("r1");

      // Drop the connection and let the grace period expire — same
      // injectable-clock technique the other offline tests in this file
      // use.
      adapter.setConnection("r1" as RobotId, false);
      orch.tickOnce();
      clock.advance(6_000);
      orch.tickOnce(); // handleOfflineTimeouts fires THIS tick

      expect(
        orch.getAlarms().some((a) => a.includes("robot r1 offline") && a.includes("requeued"))
      ).toBe(true);

      // (a) r1's TRUE physical position is owned by itself, immediately,
      // same tick — not left unowned for runDispatch/runRouting (which
      // already ran, or are about to run, later in this very tick) to
      // grant away to r2.
      const r1Pos = orch.snapshot().robots.find((r) => r.id === "r1")?.pos;
      expect(r1Pos).toBeDefined();
      const r1Cell = cellKey(r1Pos!);
      expect(orch._reservationOwner(r1Cell)).toBe("r1");
      // The empty-grant alarm added for finding 4 must NOT fire here —
      // this test's whole point is that the fix prevents the violation it
      // would otherwise detect.
      expect(orch.getAlarms().some((a) => a.includes("collision-hole invariant violated"))).toBe(false);

      // (b) drive the rest of the scenario (order gets requeued and
      // re-dispatched to r2, which must route around r1's frozen corridor
      // cell) and confirm no OTHER robot's sent mission ever contains it.
      for (let i = 0; i < 60; i++) {
        const status = orch.snapshot().orders.find((o) => o.id === order.id)?.status;
        if (status === "underway") orch.tickOnce();
        else {
          adapter.tick();
          orch.tickOnce();
        }
      }
      for (const m of sent) {
        if (m.robotId === "r1") continue;
        for (const n of m.nodeIds) {
          expect(
            cellKey(map.node(n).pos),
            `${m.robotId} ${m.id} routed through r1's frozen cell ${r1Cell}`
          ).not.toBe(r1Cell);
        }
      }
      expect(orch.getAlarms().some((a) => a.includes("collision-hole invariant violated"))).toBe(false);
    });

    it("a rejected sendMission is retried the next tick instead of hanging", async () => {
      // Direct regression test for review finding 4 (Important): with
      // gated extension, leg.sent was set unconditionally, so a
      // transiently-rejected send was never retried once nothing else
      // changed — no further extension needed (frontier already at goal),
      // so `changed` stays false forever and the order would hang with no
      // backstop (reservation claims keep succeeding; it's the adapter
      // send itself that's failing).
      //
      // Pickup is r1's OWN starting cell so the pick leg's frontier already
      // equals its goal the instant it's created — no extension is ever
      // attempted, isolating the retry-on-failed-send path as the ONLY
      // possible cause of a second send (a legitimate extension-driven
      // resend would otherwise mask whether this fix is doing anything).
      class FlakySendAdapter extends FakeAdapter {
        private failuresLeft: number;
        constructor(
          robots: Array<{ id: RobotId; startNodeId: string }>,
          map: WarehouseMap,
          failuresLeft: number
        ) {
          super(robots, map);
          this.failuresLeft = failuresLeft;
        }
        override async sendMission(m: Mission, mp: WarehouseMap): Promise<void> {
          if (this.failuresLeft > 0) {
            this.failuresLeft--;
            throw new Error("simulated transient send failure");
          }
          return super.sendMission(m, mp);
        }
      }

      const map = grid(4);
      const adapter = new FlakySendAdapter([{ id: "r1", startNodeId: "n0_0" }], map, 1);
      const sent = spyMissions(adapter);
      const orch = new Orchestrator(map, adapter, {});
      adapter.tick();
      orch.tickOnce();
      const order = orch.submitOrder("n0_0", "n3_3");

      orch.tickOnce(); // dispatch + first (failing) send attempt
      expect(sent.length).toBe(1);

      // Let the rejected promise's .catch() microtask run.
      await new Promise((r) => setTimeout(r, 0));
      expect(orch.getAlarms().some((a) => a.includes("sendMission failed"))).toBe(true);

      orch.tickOnce(); // must retry: nothing else would trigger a resend here
      expect(sent.length).toBe(2);
      expect(sent[0]!.nodeIds).toEqual(sent[1]!.nodeIds);

      let completed = false;
      for (let i = 0; i < 60 && !completed; i++) {
        adapter.tick();
        orch.tickOnce();
        completed = orch.snapshot().orders.find((o) => o.id === order.id)?.status === "completed";
      }
      expect(completed).toBe(true);
    });
  });

  /**
   * Shared 3x2-corridor setup for the yield-dispatch tests below: r1 at
   * n0_0, r2 idle-parked at n1_0. 3x1 would have NO side-step cell for r2
   * to yield into (see the dedicated 3x1 test), so 3x2 gives r2 somewhere
   * legal to go (e.g. n1_1). Registers both robots (one adapter+orchestrator
   * tick) before returning. `sent` is `spyMissions`' running log, useful for
   * asserting what a robot's actual sent paths were.
   */
  function setupYieldCorridor(orchOpts: Partial<{
    yieldAfterTicks: number;
    yieldCooldownTicks: number;
    blockedTicksLimit: number;
  }> = {}): {
    map: WarehouseMap;
    adapter: FakeAdapter;
    sent: Array<{ robotId: string; id: string; nodeIds: string[] }>;
    orch: Orchestrator;
  } {
    const map = WarehouseMap.fromJSON(WarehouseMap.grid(3, 2));
    const adapter = new FakeAdapter(
      [
        { id: "r1" as RobotId, startNodeId: "n0_0" },
        { id: "r2" as RobotId, startNodeId: "n1_0" },
      ],
      map
    );
    const sent = spyMissions(adapter);
    const orch = new Orchestrator(map, adapter, {
      horizon: 3,
      yieldAfterTicks: 3,
      blockedTicksLimit: 30, // backstop far away by default: yield must be what resolves it
      ...orchOpts,
    });
    adapter.tick();
    orch.tickOnce();
    return { map, adapter, sent, orch };
  }

  describe("yield dispatch (#13)", () => {
    it("a parked idle robot yields out of the only corridor and the order completes", () => {
      const { adapter, sent, orch } = setupYieldCorridor();
      // r2 must NOT take the order: dispatch is distance-based Hungarian, so
      // submit the order pickup at r1's own cell (distance 0). r1's pick leg
      // completes instantly (already there), then the DROP leg n0_0->n2_0
      // must cross r2 at n1_0.
      const order = orch.submitOrder("n0_0", "n2_0");
      let completed = false;
      for (let i = 0; i < 120 && !completed; i++) {
        adapter.tick();
        orch.tickOnce();
        completed =
          orch.snapshot().orders.find((o) => o.id === order.id)?.status === "completed";
      }
      expect(completed).toBe(true);
      const alarms = orch.getAlarms();
      const yieldAlarm = alarms.find((a) => a.includes("asked to vacate to"));
      expect(yieldAlarm).toBeDefined();
      // The yield must have resolved it BEFORE any backstop requeue — and
      // also before any #14/#15 recovery ("recovering (order requeued)")
      // intruding on a leg that is behaving normally; either alarm shape
      // requeueing the order here would mean this test's own yield episode
      // is spuriously tripping the off-window/watchdog checks, which must
      // not pass silently.
      expect(
        alarms.some(
          (a) => a.includes("requeueing order") || a.includes("recovering (order requeued)")
        )
      ).toBe(false);

      // Review finding (Important): the yield target must not be the
      // blocked robot's own goal, nor anywhere on its actual traveled
      // path — otherwise the "yield" just relocates the blocker onto the
      // very route it's supposed to be clearing, trading one deadlock for
      // an equivalent (or worse) one instead of resolving it.
      const match = yieldAlarm!.match(/asked to vacate to (\S+) \(blocking/);
      expect(match).not.toBeNull();
      const yieldTarget = match![1]!;
      expect(yieldTarget).not.toBe("n2_0"); // the order's drop node
      const r1Nodes = new Set(sent.filter((m) => m.robotId === "r1").flatMap((m) => m.nodeIds));
      expect(r1Nodes.has(yieldTarget)).toBe(false);

      // r2 ended up somewhere, still owns its own cell (invariant):
      const r2 = adapter.robots().find((r) => r.id === "r2")!;
      const r2cell: CellKey = cellKey(r2.pos);
      expect(orch._reservationOwner(r2cell)).toBe("r2");
    });

    it("yield legs never touch the order book and clear on completion", () => {
      // Same corridor setup as above: r1's drop leg must cross r2 parked at
      // n1_0, forcing a yield.
      const { map, adapter, orch } = setupYieldCorridor();
      const order = orch.submitOrder("n0_0", "n2_0");
      let completed = false;
      // The brief's actual claim: r2 never becomes ANY order's holder while
      // the yield is in flight. Poll every tick (not just once at the end)
      // so a hypothetical transient assign-then-unassign within a single
      // tick can't slip past an end-of-loop-only check.
      let everSawR2Assigned = false;
      for (let i = 0; i < 120 && !completed; i++) {
        adapter.tick();
        orch.tickOnce();
        if (orch.snapshot().orders.some((o) => o.robotId === "r2")) {
          everSawR2Assigned = true;
        }
        completed =
          orch.snapshot().orders.find((o) => o.id === order.id)?.status === "completed";
      }
      expect(completed).toBe(true);
      expect(everSawR2Assigned).toBe(false);
      expect(orch.getAlarms().some((a) => a.includes("asked to vacate to"))).toBe(true);

      // The yield leg never touched the order book: r2 never became this
      // order's robot.
      const finalOrder = orch.snapshot().orders.find((o) => o.id === order.id)!;
      expect(finalOrder.robotId).toBe("r1");

      // r2's leg is cleared at the end: it's dispatchable again. Submit a
      // fresh order pinned exactly at r2's current cell (distance 0, so
      // Hungarian must assign it to r2 regardless of where r2 ended up) and
      // confirm r2 takes and completes it.
      const r2 = adapter.robots().find((r) => r.id === "r2")!;
      const r2NodeId = `n${r2.pos.x}_${r2.pos.y}`;
      const otherNode = map.nodeIds.find((n) => n !== r2NodeId)!;
      const order2 = orch.submitOrder(r2NodeId, otherNode);
      let completed2 = false;
      for (let i = 0; i < 60 && !completed2; i++) {
        adapter.tick();
        orch.tickOnce();
        completed2 =
          orch.snapshot().orders.find((o) => o.id === order2.id)?.status === "completed";
      }
      expect(completed2).toBe(true);
      expect(orch.snapshot().orders.find((o) => o.id === order2.id)?.robotId).toBe("r2");
    });

    it("no qualifying blocker means no yield and the backstop still fires", () => {
      // Blocker is OFFLINE (setConnection(false) after registration): yield
      // must NOT be dispatched to an offline robot; order eventually fails
      // via backstop (blockedTicksLimit small) — the strictly-better
      // property: behavior degrades to pre-yield behavior, never worse.
      const { adapter, orch } = setupYieldCorridor({ blockedTicksLimit: 5 });
      adapter.setConnection("r2" as RobotId, false);
      orch.tickOnce();
      const order = orch.submitOrder("n0_0", "n2_0");
      let terminal = false;
      for (let i = 0; i < 60 && !terminal; i++) {
        adapter.tick();
        orch.tickOnce();
        terminal = orch.snapshot().orders.find((o) => o.id === order.id)?.status === "failed";
      }
      expect(terminal).toBe(true);
      const alarms = orch.getAlarms();
      expect(alarms.some((a) => a.includes("yield") && a.includes("r2"))).toBe(false);
      expect(alarms.some((a) => a.includes("requeueing order"))).toBe(true);
    });

    it("3x1 corridor with no side-step cell: no yield is dispatched, backstop still resolves it", () => {
      // Review finding (Important, regression coverage): findYieldTarget
      // now excludes the blocked robot's own route/goal from candidacy. On
      // a bare 3x1 corridor, r2's only two neighbors (n0_0 and n2_0) are
      // BOTH on the blocked robot's route (n0_0 is its own current
      // position, n2_0 is its goal) and nothing else is reachable within
      // the BFS depth cap — so no valid yield target exists at all. Confirm
      // yield is never even attempted (no "asked to vacate to" alarm) and
      // the deadlock backstop alone resolves it exactly as it did before
      // #13 existed — the strictly-better property.
      const map = WarehouseMap.fromJSON(WarehouseMap.grid(3, 1));
      const adapter = new FakeAdapter(
        [
          { id: "r1" as RobotId, startNodeId: "n0_0" },
          { id: "r2" as RobotId, startNodeId: "n1_0" },
        ],
        map
      );
      const orch = new Orchestrator(map, adapter, {
        horizon: 3,
        yieldAfterTicks: 3,
        blockedTicksLimit: 10,
      });
      adapter.tick();
      orch.tickOnce();
      // Same "pickup at r1's own cell" trick as the other yield tests:
      // r1 is assigned (distance 0), its pick leg completes instantly, and
      // the drop leg n0_0->n2_0 is blocked by r2 parked at n1_0.
      const order = orch.submitOrder("n0_0", "n2_0");
      let terminal = false;
      for (let i = 0; i < 200 && !terminal; i++) {
        adapter.tick();
        orch.tickOnce();
        terminal = orch.snapshot().orders.find((o) => o.id === order.id)?.status === "failed";
      }
      expect(terminal).toBe(true);
      const alarms = orch.getAlarms();
      expect(alarms.some((a) => a.includes("asked to vacate to"))).toBe(false);
      expect(alarms.some((a) => a.includes("requeueing order"))).toBe(true);
    });

    it("#13 mission-id-shape gap: a stale yield missionFailed does not clear a live ORDER leg", () => {
      // Review finding (Important): a late `yield:<id>#<n>` missionFailed
      // draining AFTER that yield leg was already superseded by a brand-new
      // ORDER leg must be recognized as a stale yield report by missionId
      // SHAPE alone, not by the robot's CURRENT leg kind — otherwise it
      // falls through to the unparseable-mission-id branch, which
      // unconditionally clears rt.leg, silently killing the live order leg
      // while the order stays dispatched/underway in the book forever
      // (robot excluded from redispatch, order never requeued — hung).
      //
      // Reproduced by direct event injection (ScriptableAdapter), since
      // nothing here ever dispatches a real yield leg to r2 — this is
      // purely about missionId shape, not an actual yield scenario.
      const map = grid(4);
      const adapter = new ScriptableAdapter([{ id: "r2" as RobotId, startNodeId: "n0_0" }], map);
      const orch = new Orchestrator(map, adapter, {});
      adapter.tick();
      orch.tickOnce();
      const order = orch.submitOrder("n2_0", "n3_3");

      // Drive it forward until r2 genuinely holds a live, non-terminal
      // order leg (dispatched or underway — either proves the leg exists).
      let holding = false;
      for (let i = 0; i < 20 && !holding; i++) {
        adapter.tick();
        orch.tickOnce();
        const status = orch.snapshot().orders.find((o) => o.id === order.id)?.status;
        holding = status === "dispatched" || status === "underway";
      }
      expect(holding).toBe(true);
      expect(orch.snapshot().orders.find((o) => o.id === order.id)?.robotId).toBe("r2");
      const statusBefore = orch.snapshot().orders.find((o) => o.id === order.id)?.status;

      adapter.injectEvent({
        type: "missionFailed",
        robotId: "r2" as RobotId,
        missionId: "yield:r2#1",
        reason: "stale test injection",
      });
      orch.tickOnce();

      // The live order leg must be untouched: status unchanged, still r2's.
      const afterOrder = orch.snapshot().orders.find((o) => o.id === order.id)!;
      expect(afterOrder.status).toBe(statusBefore);
      expect(afterOrder.robotId).toBe("r2");
      expect(
        orch.getAlarms().some((a) => a.includes("stale yield missionFailed") && a.includes("r2"))
      ).toBe(true);

      // And the order goes on to complete normally — direct proof the leg
      // survived (a cleared leg would never progress or complete again).
      let completed = false;
      for (let i = 0; i < 60 && !completed; i++) {
        adapter.tick();
        orch.tickOnce();
        completed =
          orch.snapshot().orders.find((o) => o.id === order.id)?.status === "completed";
      }
      expect(completed).toBe(true);
    });
  });

  describe("off-window reconciliation (#14)", () => {
    it("a robot reported off its committed path gets its order requeued and cell re-claimed", () => {
      // Drive the leg's COMMITMENT forward (horizon-gated extension, purely
      // reservation-driven) WITHOUT ever calling adapter.tick(): this
      // deliberately keeps rt.lastVdaNodeId undefined for the whole test
      // (only missionProgress events — themselves only ever emitted by
      // adapter.tick() — set it), isolating fix (a) (full committed-path
      // membership) from fix (b)'s rt.lastVdaNodeId fallback, which would
      // otherwise let a stale-but-genuinely-on-path lastVdaNodeId mask a
      // real drift for the rest of the leg's lifetime once the robot has
      // ever legitimately moved even once. Then inject two consecutive
      // state events snapping the robot to a node NOT anywhere on its
      // committed path (grid(4,4), teleport to the far corner). Expect:
      // "off committed path" alarm, order requeued (retries incremented,
      // order back to queued), robot's holds released, its ACTUAL current
      // cell re-claimed (via _reservationOwner).
      const map = grid(4);
      const adapter = new ScriptableAdapter([{ id: "r1" as RobotId, startNodeId: "n0_0" }], map);
      const orch = new Orchestrator(map, adapter, {});
      adapter.tick();
      orch.tickOnce();
      const order = orch.submitOrder("n3_0", "n0_3");

      // Dispatch, then let a couple more orchestrator-only ticks commit
      // further extension ahead of the robot's (unmoved) true position —
      // "partway" in commitment, not physical travel. No adapter.tick() at
      // any point, so no missionProgress ever fires for this leg.
      orch.tickOnce();
      orch.tickOnce();
      const dispatchedBefore = orch.snapshot().orders.find((o) => o.id === order.id);
      expect(dispatchedBefore?.status).toBe("dispatched");
      const beforeDrift = orch.snapshot().robots.find((r) => r.id === "r1")!;
      expect(beforeDrift.pos).toEqual(map.node("n0_0").pos); // sanity: never physically moved

      // Two consecutive off-window snaps to the far corner (n3_3) — nowhere
      // on the committed path toward n3_0.
      adapter.injectEvent({
        type: "state",
        state: { ...beforeDrift, pos: map.node("n3_3").pos },
      });
      orch.tickOnce();
      expect(
        orch.getAlarms().some((a) => a.includes("off committed path"))
      ).toBe(false); // single stale snap must not trip it yet

      adapter.injectEvent({
        type: "state",
        state: { ...beforeDrift, pos: map.node("n3_3").pos },
      });
      orch.tickOnce();

      expect(
        orch.getAlarms().some((a) => a.includes("off committed path") && a.includes("r1"))
      ).toBe(true);

      const afterOrder = orch.snapshot().orders.find((o) => o.id === order.id)!;
      expect(afterOrder.status).toBe("queued");
      expect(afterOrder.retries).toBeGreaterThanOrEqual(1);

      const r1After = orch.snapshot().robots.find((r) => r.id === "r1")!;
      expect(r1After.pos).toEqual(map.node("n3_3").pos);
      expect(orch._reservationOwner(cellKey(r1After.pos))).toBe("r1");
    });

    it("a single-tick stale snap does NOT trigger recovery", () => {
      // One off-window state event followed by an on-window one: no alarm,
      // leg intact, order completes normally.
      const map = grid(4);
      const adapter = new ScriptableAdapter([{ id: "r1" as RobotId, startNodeId: "n0_0" }], map);
      const orch = new Orchestrator(map, adapter, {});
      adapter.tick();
      orch.tickOnce();
      const order = orch.submitOrder("n2_0", "n0_2");

      step(orch, adapter);
      const r1 = orch.snapshot().robots.find((r) => r.id === "r1")!;

      // One off-window snap...
      adapter.injectEvent({
        type: "state",
        state: { ...r1, pos: map.node("n3_3").pos },
      });
      orch.tickOnce();
      expect(orch.getAlarms().some((a) => a.includes("off committed path"))).toBe(false);

      // ...followed by an on-window one (revert to the real current node) —
      // the transient snap tolerance must reset, not accumulate.
      adapter.injectEvent({
        type: "state",
        state: { ...r1, pos: r1.pos },
      });
      orch.tickOnce();
      expect(orch.getAlarms().some((a) => a.includes("off committed path"))).toBe(false);

      let completed = false;
      for (let i = 0; i < 60 && !completed; i++) {
        step(orch, adapter);
        completed = orch.snapshot().orders.find((o) => o.id === order.id)?.status === "completed";
      }
      expect(completed).toBe(true);
      expect(orch.getAlarms().some((a) => a.includes("off committed path"))).toBe(false);
    });

    it("repeated off-window/on-window alternation never accumulates (offWindowTicks resets every on-window tick)", () => {
      // Review finding (Important 4): the single-alternation test above
      // would still pass even if offWindowTicks were cumulative across
      // NON-consecutive off ticks (it only ever tests one off, one on).
      // Repeat the off->on cycle several times — if the counter were wrongly
      // cumulative (e.g. never reset, or only reset on a genuine progress
      // advance rather than every on-window tick), five single-tick offs
      // would sum past the >=2 threshold and wrongly recover a leg that in
      // fact never had two CONSECUTIVE off ticks. Assert the leg survives
      // every cycle and the order completes normally.
      const map = grid(4);
      const adapter = new ScriptableAdapter([{ id: "r1" as RobotId, startNodeId: "n0_0" }], map);
      const orch = new Orchestrator(map, adapter, {});
      adapter.tick();
      orch.tickOnce();
      const order = orch.submitOrder("n3_0", "n0_3");
      orch.tickOnce();
      const r1 = orch.snapshot().robots.find((r) => r.id === "r1")!;

      for (let cycle = 0; cycle < 5; cycle++) {
        adapter.injectEvent({
          type: "state",
          state: { ...r1, pos: map.node("n3_3").pos },
        });
        orch.tickOnce();
        adapter.injectEvent({
          type: "state",
          state: { ...r1, pos: r1.pos },
        });
        orch.tickOnce();
      }
      expect(orch.getAlarms().some((a) => a.includes("off committed path"))).toBe(false);
      expect(orch.snapshot().orders.find((o) => o.id === order.id)?.status).toBe("dispatched");

      let completed = false;
      for (let i = 0; i < 60 && !completed; i++) {
        step(orch, adapter);
        completed = orch.snapshot().orders.find((o) => o.id === order.id)?.status === "completed";
      }
      expect(completed).toBe(true);
      expect(orch.getAlarms().some((a) => a.includes("off committed path"))).toBe(false);
    });

    it("CRITICAL regression: a resumed leg survives a subsequent event-free tick (reviewer repro A, based on test (e))", () => {
      // Reviewer-reported false positive against the first version of this
      // check (Critical): after a frontier-race RESUME (handleMissionDone
      // reseeds nodeIds to JUST [frontierNode]), the windowed
      // (leg.nodeIds.slice(progressIndex)) membership test — with no
      // rt.lastVdaNodeId fallback — flagged the very NEXT event-free tick as
      // off-window too (rt.currentNodeId is sticky, still the stale
      // pre-resume snap that was never part of the reseeded 1-node path),
      // reaching the 2-consecutive threshold and requeueing a perfectly
      // healthy, just-resumed leg. Reproduces test (e)'s exact scenario
      // (see "(e) committed-path-complete resume via authoritative
      // lastVdaNodeId..." above) plus ONE additional event-free tickOnce().
      const map = grid(5);
      const adapter = new ScriptableAdapter([{ id: "r1" as RobotId, startNodeId: "n0_0" }], map);
      // Small horizon so the pick leg's frontier caps well short of the
      // pickup goal (n0_0 -> n1_0 -> n2_0, horizon 2, goal n4_0).
      const orchestrator = new Orchestrator(map, adapter, { horizon: 2 });
      adapter.tick();
      orchestrator.tickOnce();
      const order = orchestrator.submitOrder("n4_0", "n0_0");

      orchestrator.tickOnce(); // dispatch + first extension attempt(s)
      step(orchestrator, adapter); // one physical step: robot moves to n1_0, one behind the n2_0 frontier
      const r1 = orchestrator.snapshot().robots.find((r) => r.id === "r1");
      expect(r1?.pos).toEqual(map.node("n1_0").pos);

      const missionId = `${order.id}:pick`;
      // Same race as test (e): missionProgress confirms the frontier n2_0
      // (sets both rt.lastVdaNodeId AND rt.currentNodeId), then a stale
      // state event regresses rt.currentNodeId back to n1_0, then
      // missionDone triggers the resume (reseeding nodeIds to ["n2_0"]).
      adapter.injectEvent({
        type: "missionProgress",
        robotId: "r1",
        missionId,
        lastNodeId: "n2_0",
      });
      adapter.injectEvent({
        type: "state",
        state: { ...r1!, pos: map.node("n1_0").pos, status: "EXECUTING" },
      });
      adapter.injectEvent({ type: "missionDone", robotId: "r1", missionId });
      orchestrator.tickOnce();

      expect(orchestrator.getAlarms().some((a) => a.includes("resuming, not requeueing"))).toBe(true);
      expect(orchestrator.getAlarms().some((a) => a.includes("off committed path"))).toBe(false);

      // The reviewer's exact repro: ONE additional event-free tick (no new
      // adapter/injected events at all — rt.currentNodeId stays sticky at
      // the stale "n1_0"). Pre-fix, this alone pushed offWindowTicks from 1
      // (accrued during the resume tick itself) to 2, requeueing the order.
      orchestrator.tickOnce();

      expect(orchestrator.getAlarms().some((a) => a.includes("off committed path"))).toBe(false);
      const afterOrder = orchestrator.snapshot().orders.find((o) => o.id === order.id)!;
      expect(afterOrder.status).toBe("dispatched");
      expect(afterOrder.retries).toBe(0);
    });

    it("CRITICAL regression: a truthful but lagging position snap does not requeue an on-path robot (reviewer repro B)", () => {
      // Reviewer-reported false positive (Critical): missionProgress sets
      // BOTH rt.lastVdaNodeId and rt.currentNodeId to the confirmed node,
      // advancing progressIndex to it. A SUBSEQUENT truthful "state" event
      // reporting an EARLIER, already-traversed node (routine lag between
      // the position sensor and the VDA node-reached signal — see
      // RobotRuntime.lastVdaNodeId's own doc comment) unconditionally
      // overwrites rt.currentNodeId backward. Windowed
      // (leg.nodeIds.slice(progressIndex)) membership does not contain that
      // earlier node (it's BEHIND progressIndex, sliced out) — two such
      // truthful lagging snaps in a row would wrongly requeue a genuinely
      // on-path, healthy robot. Reproduced directly via injectEvent (no
      // resume/frontier-race involved this time — a plain mid-leg lag).
      const map = grid(5);
      const adapter = new ScriptableAdapter([{ id: "r1" as RobotId, startNodeId: "n0_0" }], map);
      const orchestrator = new Orchestrator(map, adapter, { horizon: 5 });
      adapter.tick();
      orchestrator.tickOnce();
      const order = orchestrator.submitOrder("n4_0", "n0_0");
      orchestrator.tickOnce(); // dispatch + first extension step

      // Let extension fully commit the path all the way to the goal
      // (n0_0..n4_0, 4 hops) BEFORE any position report arrives — purely
      // reservation-driven, no adapter.tick(), no events, robot's true
      // position stays n0_0 throughout. This is essential for the repro:
      // progressIndex must be able to advance to n3_0's index (3) with n2_0
      // already committed BEHIND it, or the later "lag" report would just
      // look like ordinary never-yet-reached forward progress instead of a
      // genuine lag behind an already-confirmed position.
      for (let i = 0; i < 5; i++) orchestrator.tickOnce();

      // missionProgress confirms n3_0 as reached — sets rt.lastVdaNodeId AND
      // rt.currentNodeId to n3_0, advancing progressIndex past n2_0.
      const missionId = `${order.id}:pick`;
      adapter.injectEvent({
        type: "missionProgress",
        robotId: "r1",
        missionId,
        lastNodeId: "n3_0",
      });
      orchestrator.tickOnce();
      expect(orchestrator.getAlarms().some((a) => a.includes("off committed path"))).toBe(false);

      const r1AtN3 = orchestrator.snapshot().robots.find((r) => r.id === "r1")!;

      // Two consecutive truthful-but-lagging snaps reporting the EARLIER,
      // already-passed node n2_0 — no missionProgress accompanying either
      // (so rt.lastVdaNodeId stays at the genuinely-confirmed n3_0, which
      // fix (b) alone would already save here — this test specifically
      // isolates fix (a), the full-path-not-windowed membership check, by
      // also asserting the underlying mechanics: n2_0 IS on leg.nodeIds,
      // just behind progressIndex).
      adapter.injectEvent({
        type: "state",
        state: { ...r1AtN3, pos: map.node("n2_0").pos },
      });
      orchestrator.tickOnce();
      expect(orchestrator.getAlarms().some((a) => a.includes("off committed path"))).toBe(false);

      adapter.injectEvent({
        type: "state",
        state: { ...r1AtN3, pos: map.node("n2_0").pos },
      });
      orchestrator.tickOnce();

      expect(orchestrator.getAlarms().some((a) => a.includes("off committed path"))).toBe(false);
      const afterOrder = orchestrator.snapshot().orders.find((o) => o.id === order.id)!;
      expect(afterOrder.status).not.toBe("queued");
      expect(afterOrder.retries).toBe(0);

      // And the order goes on to complete normally afterward, driven by
      // real adapter ticks (direct proof the leg genuinely survived).
      let completed = false;
      for (let i = 0; i < 60 && !completed; i++) {
        step(orchestrator, adapter);
        completed =
          orchestrator.snapshot().orders.find((o) => o.id === order.id)?.status === "completed";
      }
      expect(completed).toBe(true);
      expect(orchestrator.getAlarms().some((a) => a.includes("off committed path"))).toBe(false);
    });
  });

  describe("physical-progress watchdog (#15)", () => {
    it("a connected robot that stops moving on a fully-extended path is recovered", () => {
      // 1 robot, order with a short leg so frontier reaches goal quickly
      // (pickup = robot's own current cell, so the pick leg's frontier
      // equals its goal from the moment it's created — extension is never
      // even attempted, so the deadlock backstop's blockedTicks counter
      // never moves off 0). Then never call adapter.tick() again (robot
      // frozen, still online, no state/progress events at all) while
      // ticking the orchestrator watchdogTicks+2 times. blockedTicksLimit is
      // set far away so the watchdog is unambiguously what fires.
      const map = grid(3);
      const adapter = new ScriptableAdapter([{ id: "r1" as RobotId, startNodeId: "n0_0" }], map);
      const orch = new Orchestrator(map, adapter, { watchdogTicks: 8, blockedTicksLimit: 30 });
      adapter.tick();
      orch.tickOnce();
      const order = orch.submitOrder("n0_0", "n2_2");
      orch.tickOnce(); // dispatch: pick leg created (frontier === goal already), sent once

      const dispatched = orch.snapshot().orders.find((o) => o.id === order.id);
      expect(dispatched?.status).toBe("dispatched");

      // Freeze: no more adapter.tick() calls at all for the rest of this
      // test — the robot never physically moves again. Stop as soon as the
      // watchdog fires (well within watchdogTicks+2 iterations) rather than
      // over-driving: r1 is idle again immediately after recovery, so
      // continuing to tick past that point would let runDispatch()
      // legitimately re-assign the very same (now re-queued) order right
      // back to it, which would itself go on to re-trip its OWN fresh
      // watchdog clock later — a correct but irrelevant second event this
      // test isn't about.
      let watchdogFired = false;
      for (let i = 0; i < 10 && !watchdogFired; i++) {
        orch.tickOnce();
        watchdogFired = orch
          .getAlarms()
          .some((a) => a.includes("no physical progress") && a.includes("r1"));
      }

      expect(watchdogFired).toBe(true);
      expect(orch.getAlarms().some((a) => a.includes("— requeueing order"))).toBe(false);

      // Minor: pin the threshold itself, not just "eventually fires" — the
      // leg was created at tick 2 (registration tick 1, dispatch tick 2,
      // lastProgressTick = 2), so with watchdogTicks: 8 the earliest
      // possible firing tick is 2 + 8 = 10. Allow ±1 for pipeline-ordering
      // slack rather than pinning the exact internal tick-counting model.
      const watchdogAlarm = orch
        .getAlarms()
        .find((a) => a.includes("no physical progress") && a.includes("r1"))!;
      const tickMatch = watchdogAlarm.match(/^t=(\d+)/);
      expect(tickMatch).not.toBeNull();
      const firedAtTick = Number(tickMatch![1]);
      expect(firedAtTick).toBeGreaterThanOrEqual(9);
      expect(firedAtTick).toBeLessThanOrEqual(11);

      const after = orch.snapshot().orders.find((o) => o.id === order.id)!;
      expect(after.status).toBe("queued");
      expect(after.retries).toBeGreaterThanOrEqual(1);

      expect(adapter.cancelCalls).toContain("r1");
      const r1 = orch.snapshot().robots.find((r) => r.id === "r1")!;
      expect(r1.status).toBe("IDLE");
      expect(orch._reservationOwner(cellKey(r1.pos))).toBe("r1");
    });

    it("IMPORTANT regression: an offline robot's stall is left to the offline-timeout path, not the watchdog", () => {
      // Review finding (Important 2): with no rt.online gate, a robot whose
      // offlineGraceMs (wall-clock) outlasts watchdogTicks*tickMs would get
      // its leg cleared and order requeued by THIS watchdog first, under a
      // misleading "no physical progress" alarm that never mentions the
      // robot is actually unreachable — and hand it back into the dispatch
      // pool as if healthy. Verify both halves: (1) while offline, with a
      // very long offlineGraceMs (never reached in this test), the watchdog
      // must stay completely silent no matter how many ticks pass; (2) once
      // back online, the SAME still-frozen robot is fair game again and the
      // watchdog fires normally.
      const map = grid(3);
      const adapter = new ScriptableAdapter([{ id: "r1" as RobotId, startNodeId: "n0_0" }], map);
      const clock = fakeClock();
      const orch = new Orchestrator(map, adapter, {
        now: clock.now,
        watchdogTicks: 8,
        blockedTicksLimit: 30,
        offlineGraceMs: 1_000_000, // effectively never, for this test
      });
      adapter.tick();
      orch.tickOnce();
      const order = orch.submitOrder("n0_0", "n2_2");
      orch.tickOnce(); // dispatch: pick leg created

      adapter.setConnection("r1" as RobotId, false);
      orch.tickOnce(); // processes the connection event -> rt.online = false

      // Frozen AND offline for well past watchdogTicks: must stay silent.
      for (let i = 0; i < 20; i++) orch.tickOnce();
      expect(orch.getAlarms().some((a) => a.includes("no physical progress"))).toBe(false);
      expect(orch.snapshot().orders.find((o) => o.id === order.id)?.status).toBe("dispatched");

      // Reconnect: still frozen (no adapter.tick() call resumes), so the
      // watchdog — now eligible again — should fire shortly after.
      adapter.setConnection("r1" as RobotId, true);
      let watchdogFired = false;
      for (let i = 0; i < 10 && !watchdogFired; i++) {
        orch.tickOnce();
        watchdogFired = orch
          .getAlarms()
          .some((a) => a.includes("no physical progress") && a.includes("r1"));
      }
      expect(watchdogFired).toBe(true);
    });

    it("IMPORTANT round-2 regression: reconnecting after an outage longer than watchdogTicks grants a fresh window instead of instant-firing", () => {
      // Review round-2 finding: the #15 gate on rt.online stops the CHECK
      // from evaluating while offline, but tickCount keeps advancing the
      // whole time regardless of connectivity, and leg.lastProgressTick was
      // never refreshed on reconnect. A robot offline for LONGER than
      // watchdogTicks (but shorter than offlineGraceMs, so
      // handleOfflineTimeouts() never claims it first) would, pre-fix, have
      // the gate lifted back on the very first post-reconnect tick with an
      // already-expired clock — firing before the robot could report so
      // much as one tick of real movement. Fixed: the "connection" event
      // handler refreshes lastProgressTick (and offWindowTicks) to the
      // current tick on an offline->online transition.
      const map = grid(5);
      const adapter = new FakeAdapter([{ id: "r1" as RobotId, startNodeId: "n0_0" }], map);
      const orch = new Orchestrator(map, adapter, {
        watchdogTicks: 5,
        blockedTicksLimit: 30,
        offlineGraceMs: 10_000_000, // never reached in this test
      });
      adapter.tick();
      orch.tickOnce();
      const order = orch.submitOrder("n4_0", "n0_0");
      orch.tickOnce(); // dispatch: pick leg created

      adapter.setConnection("r1" as RobotId, false);
      orch.tickOnce(); // processes the connection event -> rt.online = false

      // Stay offline for well longer than watchdogTicks (5) — the
      // orchestrator keeps ticking (tickCount keeps advancing) throughout;
      // only the #14/#15 CHECK is suppressed by the rt.online gate.
      for (let i = 0; i < 12; i++) orch.tickOnce();
      expect(orch.getAlarms().some((a) => a.includes("no physical progress"))).toBe(false);

      // Reconnect. Pre-fix, this single tick alone (tickCount already far
      // past lastProgressTick + watchdogTicks, using the STALE
      // pre-outage lastProgressTick) would fire the watchdog immediately,
      // right here, before the robot ever got a chance to move again.
      adapter.setConnection("r1" as RobotId, true);
      orch.tickOnce();
      expect(orch.getAlarms().some((a) => a.includes("no physical progress"))).toBe(false);

      // Next ticks make real progress; the order completes normally with no
      // watchdog alarm ever firing.
      let completed = false;
      for (let i = 0; i < 60 && !completed; i++) {
        step(orch, adapter);
        completed = orch.snapshot().orders.find((o) => o.id === order.id)?.status === "completed";
      }
      expect(completed).toBe(true);
      expect(orch.getAlarms().some((a) => a.includes("no physical progress"))).toBe(false);
    });

    it("IMPORTANT regression: a genuinely blocked leg is resolved by the backstop before the watchdog ever fires", () => {
      // Review finding (Important 3): the watchdogTicks > blockedTicksLimit
      // interaction must be proven with a real run, not assumed. 3x1
      // corridor deadlock — same shape as the "sustained reservation
      // contention requeues the order (deadlock backstop)" test above — r2
      // permanently parks mid-corridor, blocking r1's only route. Yield
      // dispatch disabled (yieldAfterTicks: 999, far above
      // blockedTicksLimit) so only the backstop and the watchdog are in
      // play. Scaled-down but ratio-preserving thresholds
      // (blockedTicksLimit 5, watchdogTicks 10 — production default ratio
      // is 20:40, i.e. 1:2) so the run converges quickly while still
      // exercising several backstop-requeue/redispatch cycles, each
      // re-creating a FRESH leg (fresh lastProgressTick) well inside
      // blockedTicksLimit every time — the watchdog must never get the
      // chance, on any single leg incarnation, to accumulate anywhere near
      // its own larger threshold, even though the run's TOTAL elapsed
      // ticks comfortably exceeds watchdogTicks several times over.
      const map = WarehouseMap.fromJSON(WarehouseMap.grid(3, 1));
      const adapter = new FakeAdapter(
        [
          { id: "r1" as RobotId, startNodeId: "n0_0" },
          { id: "r2" as RobotId, startNodeId: "n1_0" },
        ],
        map
      );
      const orch = new Orchestrator(map, adapter, {
        horizon: 3,
        blockedTicksLimit: 5,
        watchdogTicks: 10,
        yieldAfterTicks: 999,
      });
      adapter.tick();
      orch.tickOnce();
      const order = orch.submitOrder("n2_0", "n0_0");

      // Same tick-driving strategy as the pre-existing deadlock-backstop
      // test (see its own comment for the full rationale): pair ticks only
      // while the order is NOT "underway" (physical movement genuinely
      // needed for the pick leg / any post-requeue re-pick), then
      // orchestrator-only ticks once "underway" so the robot never
      // physically catches up to finish a stale short mission early and
      // blockedTicks is free to climb to the backstop's limit.
      let terminal = false;
      for (let i = 0; i < 300 && !terminal; i++) {
        const status = orch.snapshot().orders.find((o) => o.id === order.id)?.status;
        if (status === "underway") {
          orch.tickOnce();
        } else {
          adapter.tick();
          orch.tickOnce();
        }
        terminal = orch.snapshot().orders.find((o) => o.id === order.id)?.status === "failed";
      }
      expect(terminal).toBe(true);
      expect(orch.getAlarms().some((a) => a.includes("— requeueing order"))).toBe(true);
      expect(orch.getAlarms().some((a) => a.includes("no physical progress"))).toBe(false);
      expect(orch.getAlarms().some((a) => a.includes("off committed path"))).toBe(false);
    });

    it("normal slow progress does not trip the watchdog", () => {
      // adapter.tick() every 3rd orchestrator tick, watchdogTicks 8: order
      // completes, no watchdog alarm (each progress event resets the clock).
      const map = grid(4);
      const adapter = new FakeAdapter([{ id: "r1" as RobotId, startNodeId: "n0_0" }], map);
      const orch = new Orchestrator(map, adapter, { watchdogTicks: 8 });
      adapter.tick();
      orch.tickOnce();
      const order = orch.submitOrder("n0_3", "n3_0");

      let completed = false;
      for (let i = 0; i < 200 && !completed; i++) {
        if (i % 3 === 0) adapter.tick();
        orch.tickOnce();
        completed = orch.snapshot().orders.find((o) => o.id === order.id)?.status === "completed";
      }
      expect(completed).toBe(true);
      expect(orch.getAlarms().some((a) => a.includes("no physical progress"))).toBe(false);
    });
  });

  describe("growth hygiene: alarm ring buffer (#8)", () => {
    it("alarm log is capped and reports how many were dropped", () => {
      // Bare 3x1 corridor, r2 idle-parked at n1_0 (see the dedicated "3x1
      // corridor with no side-step cell" yield test above): there is no
      // side-step cell for r2 to yield into and no alternate route around
      // it, so r1's drop leg (n0_0 -> n2_0) is permanently blocked and
      // "contention: ... no forward candidate" fires exactly once per
      // orchestrator tick, forever, with nothing to ever resolve it.
      // blockedTicksLimit is set far above this test's own tick budget so
      // the deadlock backstop never fires and requeues/resets the leg —
      // the alarm stream just keeps climbing, which is exactly the
      // unbounded-growth condition pushAlarm()'s cap exists to guard
      // against.
      const map = WarehouseMap.fromJSON(WarehouseMap.grid(3, 1));
      const adapter = new FakeAdapter(
        [
          { id: "r1" as RobotId, startNodeId: "n0_0" },
          { id: "r2" as RobotId, startNodeId: "n1_0" },
        ],
        map
      );
      const orch = new Orchestrator(map, adapter, {
        horizon: 3,
        yieldAfterTicks: 3,
        blockedTicksLimit: 10_000,
      });
      adapter.tick();
      orch.tickOnce();
      orch.submitOrder("n0_0", "n2_0");

      for (let i = 0; i < 600; i++) {
        adapter.tick();
        orch.tickOnce();
      }

      const alarms = orch.getAlarms();
      // Cap (500) plus at most one synthetic "dropped" head line.
      expect(alarms.length).toBeLessThanOrEqual(501);
      expect(alarms[0]).toMatch(/^\(\d+ older alarms dropped\)$/);
    });
  });
});
