import type { CellKey, RobotId } from "@tez/shared";

/**
 * ReservationTable: openTCS-style cell ownership tracking.
 * - Each cell has at most one owner (robot)
 * - claim() is atomic prefix-grant: stops at first foreign-owned cell
 * - release() frees only cells strictly behind the current position
 * - Robot motion layer may only enter cells it has claimed
 */
export class ReservationTable {
  private cellOwner: Map<CellKey, RobotId> = new Map();
  private robotCells: Map<RobotId, CellKey[]> = new Map();

  /**
   * Claim next cells for robot; returns granted prefix (may be shorter than asked).
   * Stops at the first foreign-owned cell. Idempotent for cells already owned by the robot.
   */
  claim(robot: RobotId, cells: CellKey[]): CellKey[] {
    if (cells.length === 0) {
      return [];
    }

    const granted: CellKey[] = [];

    for (const cell of cells) {
      const owner = this.cellOwner.get(cell);

      // If this cell is unowned or owned by this robot, we can claim it
      if (owner === undefined || owner === robot) {
        granted.push(cell);
        // Set ownership if not already owned by this robot
        if (!this.cellOwner.has(cell)) {
          this.cellOwner.set(cell, robot);
        }
      } else {
        // Foreign-owned cell: stop the grant here
        break;
      }
    }

    // Update or create the robot's cell list with the new granted cells
    // For idempotency: if re-claiming, we replace the list with the new granted sequence
    if (granted.length > 0) {
      this.robotCells.set(robot, granted);
    }

    return granted;
  }

  /**
   * Release all cells strictly behind current cell in the robot's claimed list.
   * If current is not in the robot's list, this is a no-op.
   */
  release(robot: RobotId, current: CellKey): void {
    const cells = this.robotCells.get(robot);
    if (!cells) {
      // Robot has no claims
      return;
    }

    const currentIndex = cells.indexOf(current);
    if (currentIndex === -1) {
      // Current cell is not in the robot's list: no-op
      return;
    }

    // Release all cells strictly before currentIndex (indices 0 to currentIndex-1)
    for (let i = 0; i < currentIndex; i++) {
      const cellToFree = cells[i]!;
      this.cellOwner.delete(cellToFree);
    }

    // Update the robot's cell list to keep only cells from currentIndex onwards
    this.robotCells.set(robot, cells.slice(currentIndex));
  }

  /**
   * Get the owner of a cell, or undefined if unowned.
   */
  owner(cell: CellKey): RobotId | undefined {
    return this.cellOwner.get(cell);
  }

  /**
   * Release all cells owned by the robot.
   */
  releaseAll(robot: RobotId): void {
    const cells = this.robotCells.get(robot);
    if (cells) {
      for (const cell of cells) {
        this.cellOwner.delete(cell);
      }
      this.robotCells.delete(robot);
    }
  }
}
