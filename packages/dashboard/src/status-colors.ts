/**
 * Status → color mapping shared by every cockpit widget. Kept in sync by
 * hand with the Pixi map's ring colors (see `src/map/renderer.ts`'s
 * `STATUS_COLORS`) so a robot's card badge, its map ring, and any order it
 * is carrying all agree on what "EXECUTING" (or "underway") looks like.
 *
 * Hex strings here (rather than renderer.ts's packed 0xRRGGBB numbers)
 * because these feed CSS (`style.color` / `style.backgroundColor`) instead
 * of Pixi's Graphics API.
 */
import type { RobotState, TransportOrder } from "./types";

export const ROBOT_STATUS_COLORS: Record<RobotState["status"], string> = {
  IDLE: "#9ca3af",
  EXECUTING: "#4f46e5",
  CHARGING: "#22c55e",
  ERROR: "#ef4444",
  UNKNOWN: "#f59e0b",
};

/**
 * Order statuses reuse the robot status color family: queued mirrors IDLE
 * (gray, nothing moving yet), dispatched/underway mirror EXECUTING (brand
 * cobalt, a robot is actively working it), completed mirrors CHARGING
 * (green, done well), failed mirrors ERROR (red), canceled mirrors UNKNOWN
 * (amber, "left the flow" rather than a hard failure).
 */
export const ORDER_STATUS_COLORS: Record<TransportOrder["status"], string> = {
  queued: "#9ca3af",
  dispatched: "#4f46e5",
  underway: "#4f46e5",
  completed: "#22c55e",
  failed: "#ef4444",
  canceled: "#f59e0b",
};
