export type RobotId = string;

export type CellKey = `${number}:${number}`;

export interface GridPos {
  x: number;
  y: number;
}

export const cellKey = (p: GridPos): CellKey => `${p.x}:${p.y}`;

export interface RobotState {
  id: RobotId;
  pos: GridPos;
  theta: number;
  battery: number; // 0..1
  status: "IDLE" | "EXECUTING" | "CHARGING" | "ERROR" | "UNKNOWN";
  currentMissionId?: string;
  lastSeen: string; // ISO
}
