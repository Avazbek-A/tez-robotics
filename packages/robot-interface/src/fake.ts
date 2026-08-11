import type { RobotId, RobotState } from "@tez/shared";
import type { WarehouseMap } from "@tez/core";
import type { Mission, AdapterEvent, RobotAdapter } from "./adapter.js";

interface FakeRobotState {
  state: RobotState;
  currentNodeIndex: number;
  online: boolean;
  mission?: {
    id: string;
    nodeIds: string[];
  };
}

/**
 * In-memory, deterministic, tick-driven `RobotAdapter` used by tests only —
 * never a real robot connection. It implements a STRONGER contract than
 * `RobotAdapter.on()`'s documented real-adapter guarantee (see that JSDoc
 * in adapter.ts), and tests that rely on the extra strength are exercising
 * fake-only behavior, not something a real adapter (e.g. Vda5050Adapter, or
 * a future seer-tcp adapter) is required to provide:
 *
 *   - Lockstep per-tick ordering: within a single `tick()` call, a robot's
 *     `missionProgress`/`missionDone` event (if any) is emitted BEFORE that
 *     robot's heartbeat `state` event, for every robot, every tick. Real
 *     adapters make no such promise relative to their own event cadence.
 *   - `missionDone` fires exactly on the tick after the robot's
 *     `currentNodeIndex` walks off the end of `nodeIds` — i.e. an N-node
 *     mission (indices 0..N-1) completes on the Nth call to `tick()` for
 *     that robot. A real adapter's completion timing is protocol- and
 *     vendor-specific.
 *   - FAKE-ONLY new-mission position teleport: `sendMission()`'s "new
 *     mission" branch (different mission id than the robot's current one)
 *     sets `robot.state.pos` straight to the FIRST node of the sent path
 *     immediately, without the robot walking there over successive
 *     `tick()` calls. This exists purely so tests can seed/reseed a robot's
 *     reported position deterministically (e.g. Orchestrator's frontier-
 *     race resume path re-sends under the same missionId specifically to
 *     land in the "extension" branch below and avoid this teleport). A real
 *     robot cannot teleport; its position only ever advances by physically
 *     traversing the path it was sent.
 *
 * Any test asserting on exact per-tick event ordering, missionDone timing,
 * or an instantaneous post-sendMission position is implicitly asserting on
 * FakeAdapter's behavior, not on `RobotAdapter`'s general contract.
 */
export class FakeAdapter implements RobotAdapter {
  private robotStates: Map<RobotId, FakeRobotState> = new Map();
  private handlers: Array<(e: AdapterEvent) => void> = [];
  private map: WarehouseMap;

  constructor(
    initialRobots: Array<{ id: RobotId; startNodeId: string }>,
    map: WarehouseMap
  ) {
    this.map = map;

    for (const robot of initialRobots) {
      const node = map.node(robot.startNodeId);
      this.robotStates.set(robot.id, {
        state: {
          id: robot.id,
          pos: node.pos,
          theta: 0,
          battery: 1,
          status: "IDLE",
          lastSeen: new Date().toISOString(),
        },
        currentNodeIndex: 0,
        online: true,
      });
    }
  }

  async start(): Promise<void> {
    // Start the adapter
  }

  async stop(): Promise<void> {
    // Stop the adapter
  }

  async sendMission(m: Mission, map: WarehouseMap): Promise<void> {
    const robot = this.robotStates.get(m.robotId);
    if (!robot) {
      throw new Error(`Robot ${m.robotId} not found`);
    }

    // Check if this is an extension of an existing mission
    if (robot.mission && robot.mission.id === m.id) {
      // Extension: validate prefix and preserve position
      const oldNodeIds = robot.mission.nodeIds;

      // Validate: new length must be > old length
      if (m.nodeIds.length <= oldNodeIds.length) {
        throw new Error(
          `invalid mission extension: new nodeIds must be longer than current (got ${m.nodeIds.length}, need > ${oldNodeIds.length})`
        );
      }

      // Validate: new nodeIds must be strict prefix extension of old
      for (let i = 0; i < oldNodeIds.length; i++) {
        if (oldNodeIds[i] !== m.nodeIds[i]) {
          throw new Error(
            `invalid mission extension: new nodeIds must preserve existing path. Mismatch at index ${i}: was "${oldNodeIds[i]}", now "${m.nodeIds[i]}"`
          );
        }
      }

      // Valid extension: update path but preserve position and current pos
      robot.mission.nodeIds = m.nodeIds;
      // currentNodeIndex stays the same - robot continues from current position
      robot.state.lastSeen = new Date().toISOString();
    } else {
      // New mission: set up fresh
      robot.mission = {
        id: m.id,
        nodeIds: m.nodeIds,
      };
      robot.currentNodeIndex = 0;

      // Only for new missions, set pos from first node
      const node = map.node(m.nodeIds[0]);
      robot.state.pos = node.pos;
      robot.state.lastSeen = new Date().toISOString();
    }

    // Common to both: set status to EXECUTING and current mission ID
    robot.state.status = "EXECUTING";
    robot.state.currentMissionId = m.id;
  }

  async cancelMission(robotId: RobotId): Promise<void> {
    const robot = this.robotStates.get(robotId);
    if (!robot) {
      throw new Error(`Robot ${robotId} not found`);
    }

    robot.mission = undefined;
    robot.state.status = "IDLE";
    robot.state.currentMissionId = undefined;
    robot.state.lastSeen = new Date().toISOString();
  }

  on(handler: (e: AdapterEvent) => void): void {
    this.handlers.push(handler);
  }

  /**
   * Test-support hook (not part of RobotAdapter): simulate a connection-loss
   * or reconnection event, e.g. an MQTT last-will firing. Emits a
   * `connection` event. While offline, tick() skips this robot entirely
   * (no state/progress/done emission and no mission advancement) — mirroring
   * a real dropped link where no telemetry arrives at all.
   */
  setConnection(robotId: RobotId, online: boolean): void {
    const robot = this.robotStates.get(robotId);
    if (!robot) {
      throw new Error(`Robot ${robotId} not found`);
    }
    robot.online = online;
    this.emit({ type: "connection", robotId, online });
  }

  /**
   * Test-support hook (not part of RobotAdapter): simulate a mission-level
   * failure (e.g. rejected action, robot fault) without going through the
   * normal tick()-driven completion path. Emits `missionFailed` and returns
   * the robot to IDLE with no active mission.
   */
  failMission(robotId: RobotId, reason = "simulated failure"): void {
    const robot = this.robotStates.get(robotId);
    if (!robot) {
      throw new Error(`Robot ${robotId} not found`);
    }
    if (!robot.mission) {
      throw new Error(`Robot ${robotId} has no active mission to fail`);
    }
    const missionId = robot.mission.id;
    robot.mission = undefined;
    robot.state.status = "IDLE";
    robot.state.currentMissionId = undefined;
    robot.state.lastSeen = new Date().toISOString();
    this.emit({ type: "missionFailed", robotId, missionId, reason });
  }

  tick(): void {
    for (const [robotId, robot] of this.robotStates.entries()) {
      if (!robot.online) {
        // Connection is down: no telemetry, no mission progress.
        continue;
      }
      if (robot.mission) {
        // Advance to next node
        robot.currentNodeIndex++;
        const nodeIds = robot.mission.nodeIds;

        if (robot.currentNodeIndex >= nodeIds.length) {
          // Mission complete
          this.emit({
            type: "missionDone",
            robotId,
            missionId: robot.mission.id,
          });
          robot.mission = undefined;
          robot.state.status = "IDLE";
          robot.state.currentMissionId = undefined;
        } else {
          // Get next node and update position
          const nextNodeId = nodeIds[robot.currentNodeIndex];
          const node = this.map.node(nextNodeId);
          robot.state.pos = node.pos;
          robot.state.lastSeen = new Date().toISOString();

          // Emit progress event
          this.emit({
            type: "missionProgress",
            robotId,
            missionId: robot.mission.id,
            lastNodeId: nextNodeId,
          });
        }
      }

      // Always emit state event for heartbeat
      this.emit({
        type: "state",
        state: { ...robot.state, lastSeen: new Date().toISOString() },
      });
    }
  }

  robots(): RobotState[] {
    return Array.from(this.robotStates.values()).map((r) => r.state);
  }

  private emit(event: AdapterEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}
