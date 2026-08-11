import type { RobotId, RobotState } from "@tez/shared";
import type { WarehouseMap } from "@tez/core";

export interface Mission {
  id: string;
  robotId: RobotId;
  nodeIds: string[]; // horizon path incl. current node
}

export type AdapterEvent =
  | { type: "state"; state: RobotState }
  | { type: "missionProgress"; robotId: RobotId; missionId: string; lastNodeId: string }
  | { type: "missionDone"; robotId: RobotId; missionId: string }
  | { type: "missionFailed"; robotId: RobotId; missionId: string; reason: string }
  | { type: "connection"; robotId: RobotId; online: boolean };

export interface RobotAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Send or extend a mission.
   * - New mission (new id): robot starts at first node, currentIndex=0
   * - Extension (same id): validates strict prefix extension; preserves robot position and currentIndex
   * @throws on invalid extension (shorter path or mismatched prefix)
   */
  sendMission(m: Mission, map: WarehouseMap): Promise<void>;
  cancelMission(robotId: RobotId): Promise<void>;
  /**
   * Subscribe to adapter events.
   * EventEmitter-style no-dedup: same handler added twice receives duplicates.
   *
   * Real-adapter contract (the ONLY guarantee every implementation —
   * including a future seer-tcp adapter — must honor): events for a given
   * robot arrive in per-robot ORDER — a mission's missionProgress event(s)
   * for that robot always precede its missionDone/missionFailed for the
   * SAME missionId. There is NO guarantee of tick alignment, cadence, or
   * relative timing against the orchestrator's own tick loop or against
   * other robots' events. In particular:
   *   - missionDone may arrive for the mission most recently SENT (e.g. a
   *     horizon- or reservation-shortened extension) before the
   *     orchestrator has observed, via state/missionProgress, that the
   *     robot physically reached the LEG's eventual goal node — a fast
   *     robot can drain a released path faster than the orchestrator issues
   *     the next extension. This is expected, not a bug: Orchestrator's
   *     handleMissionDone() has a premature-done guard (I1) that
   *     distinguishes "committed prefix fully walked, leg goal not yet
   *     reached" (resumes the leg under the same missionId) from a
   *     genuinely premature/corrupt report (cancels + requeues).
   *   - missionDone/missionFailed for an in-flight mission can also arrive
   *     for a robot the orchestrator no longer considers that mission's
   *     holder (reassigned after an offline requeue, revived robot resuming
   *     a supposedly-cancelled mission because cancelMission is
   *     best-effort). Orchestrator's verifyReportingRobot() (C1) guards
   *     against this at the order-book layer; adapters are not required to
   *     de-duplicate or suppress these late reports themselves.
   *   - No requirement that mission events fire before or after any
   *     particular heartbeat `state` event, or on any particular tick
   *     relative to when sendMission()/cancelMission() was called.
   *
   * FakeAdapter (fake.ts), used only in tests, deliberately implements a
   * STRONGER, lockstepped contract that real adapters must NOT be assumed
   * to share: per its own tick(), mission events fire synchronously within
   * that tick, BEFORE that tick's heartbeat `state` event, and a
   * missionDone fires on the tick immediately after the final node is
   * reached (an N-node mission — including the current node — completes on
   * tick N-1 of movement). See fake.ts's class-level doc for the additional
   * fake-only "new mission position teleport" affordance (a brand-new
   * mission, as opposed to an extension of the current one, snaps the
   * robot's reported position straight to the mission's first node rather
   * than requiring it to walk there).
   */
  on(handler: (e: AdapterEvent) => void): void;
}
