import type { CellKey, RobotId } from "@tez/shared";

/**
 * ReservationTable: openTCS-style cell ownership tracking.
 * - Each cell has at most one owner (robot)
 * - claim() declares the robot's complete desired hold-set in path order.
 *   Returns the longest grantable prefix (stops at first foreign-owned cell).
 *   All previously owned cells NOT in the granted prefix are released.
 *   Path revisits are deduped: a cell is held once regardless of order revisits.
 * - release() frees only cells strictly behind the current position
 * - Robot motion layer may only enter cells it has claimed
 *
 * Invariant: for every robot, a cell is in robotCells iff it is in cellOwner
 *            with the robot as owner (bidirectional consistency).
 */
export class ReservationTable {
  private cellOwner: Map<CellKey, RobotId> = new Map();
  private robotCells: Map<RobotId, CellKey[]> = new Map();

  /**
   * Claim cells for robot; returns granted prefix (may be shorter than asked).
   * Semantics: cells is the robot's desired hold-set in path order. Callers MUST include
   * the robot's current physical cell as the first element of each horizon claim, else
   * an empty grant (foreign first cell) will reject and leave the robot stranded.
   *
   * Grant = longest prefix where each cell is unowned OR already owned by this robot.
   * Stops at first foreign-owned cell.
   *
   * NO-OP on empty grant: if the granted prefix is empty (first cell is foreign OR input
   * was []), returns [] with zero state change. Robot's prior holds remain untouched.
   * All previously owned cells NOT in granted are released ONLY when grant is non-empty.
   *
   * Path revisits are deduped (keeping first occurrence) before grant computation.
   * Use releaseAll() as the only explicit full-release API.
   */
  claim(robot: RobotId, cells: CellKey[]): CellKey[] {
    // Step 1: Dedupe cells, keeping first occurrence of each unique CellKey
    const seen = new Set<CellKey>();
    const deduped: CellKey[] = [];
    for (const cell of cells) {
      if (!seen.has(cell)) {
        deduped.push(cell);
        seen.add(cell);
      }
    }

    // Step 2: Compute granted prefix (unowned or already owned by this robot)
    const granted: CellKey[] = [];
    for (const cell of deduped) {
      const owner = this.cellOwner.get(cell);
      if (owner === undefined || owner === robot) {
        granted.push(cell);
      } else {
        // Foreign-owned cell: stop the grant here
        break;
      }
    }

    // Step 3: NO-OP if grant is empty (zero state change)
    if (granted.length === 0) {
      return [];
    }

    // Step 4: Free all previously owned cells NOT in granted (only when grant non-empty)
    const prevCells = this.robotCells.get(robot) || [];
    const grantedSet = new Set(granted);
    for (const cell of prevCells) {
      if (!grantedSet.has(cell)) {
        this.cellOwner.delete(cell);
      }
    }

    // Step 5: Claim new cells in granted that aren't already owned by this robot
    for (const cell of granted) {
      if (!this.cellOwner.has(cell)) {
        this.cellOwner.set(cell, robot);
      }
    }

    // Step 6: Store granted as the robot's new list
    this.robotCells.set(robot, granted);

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

  /**
   * Internal snapshot for testing consistency.
   * Exposed for assertConsistent helper in tests.
   */
  _snapshot(): { cells: Map<CellKey, RobotId>; byRobot: Map<RobotId, CellKey[]> } {
    return {
      cells: new Map(this.cellOwner),
      byRobot: new Map(Array.from(this.robotCells, ([k, v]) => [k, [...v]]))
    };
  }
}
