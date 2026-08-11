export type RobotId = string;

/**
 * Canonical VDA5050 `mapId` for the single warehouse map every simulated
 * and real AGV in this codebase operates on. Previously duplicated as a
 * private, unexported `MAP_ID` constant in both `Vda5050Adapter`
 * (`@tez/robot-interface`) and `@tez/sim`'s `fleet.ts` — see #5 in
 * BACKLOG.md. Centralized here so both stay in lockstep by construction
 * instead of by comment-enforced convention.
 */
export const DEFAULT_MAP_ID = "warehouse";

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
