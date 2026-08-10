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
  sendMission(m: Mission, map: WarehouseMap): Promise<void>; // extend = same mission id, longer nodeIds
  cancelMission(robotId: RobotId): Promise<void>;
  on(handler: (e: AdapterEvent) => void): void;
}
