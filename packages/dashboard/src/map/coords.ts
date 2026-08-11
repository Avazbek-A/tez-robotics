/**
 * Grid <-> pixel coordinate conversion for the Pixi live map.
 *
 * The backend/orchestrator works in grid units (integer or fractional cell
 * coordinates); the map renders in pixels. The mapping is a uniform scale
 * with no axis flip: grid `y` increases downward, same as screen/pixel `y`
 * (and same as Pixi's default coordinate system), so no sign inversion is
 * needed going from grid space to pixel space.
 */

/** Pixel size of one grid cell, in both axes. */
export const CELL = 48;

export interface GridPos {
  x: number;
  y: number;
}

export interface PixelPos {
  x: number;
  y: number;
}

/** Pure conversion from grid units to pixel coordinates: `pos * CELL`, y-down. */
export function gridToPx(pos: GridPos): PixelPos {
  return { x: pos.x * CELL, y: pos.y * CELL };
}
