import type { RobotId, RobotState } from "@tez/shared";
import type { WarehouseMap } from "@tez/core";
import type { Mission, AdapterEvent, RobotAdapter } from "./adapter.js";

interface FakeRobotState {
  state: RobotState;
  currentNodeIndex: number;
  mission?: {
    id: string;
    nodeIds: string[];
  };
}

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
      // Extension: robot is currently at nodeIds[currentNodeIndex]
      const currentNodeId = robot.mission.nodeIds[robot.currentNodeIndex];
      robot.mission.nodeIds = m.nodeIds;
      // Find where currentNodeId is in the new nodeIds
      const newIndex = m.nodeIds.indexOf(currentNodeId);
      if (newIndex >= 0) {
        robot.currentNodeIndex = newIndex;
      }
    } else {
      // New mission
      robot.mission = {
        id: m.id,
        nodeIds: m.nodeIds,
      };
      robot.currentNodeIndex = 0;
    }

    // Update robot state
    const node = map.node(m.nodeIds[0]);
    robot.state.pos = node.pos;
    robot.state.status = "EXECUTING";
    robot.state.currentMissionId = m.id;
    robot.state.lastSeen = new Date().toISOString();
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

  tick(): void {
    for (const [robotId, robot] of this.robotStates.entries()) {
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
