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
   * Per-tick contract: mission events (missionProgress, missionDone) fire BEFORE heartbeat state.
   * missionDone fires on the tick AFTER final node reached (N-node mission completes on tick N).
   */
  on(handler: (e: AdapterEvent) => void): void;
}
