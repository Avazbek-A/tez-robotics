import { describe, it, expect } from "vitest";
import { ReservationTable } from "../src/reservations.js";
import type { CellKey, RobotId } from "@tez/shared";

/**
 * Assert bidirectional consistency invariant:
 * For every robot, a cell is in robotCells iff it is in cellOwner mapped to that robot.
 */
function assertConsistent(table: ReservationTable, msg?: string): void {
  const snap = table._snapshot();
  const { cells, byRobot } = snap;

  // Check: every cell in cells has a corresponding entry in byRobot
  for (const [cell, owner] of cells) {
    const robotList = byRobot.get(owner);
    expect(robotList, `${msg || ""} Cell ${cell} owned by ${owner} but not in byRobot[${owner}]`).toBeDefined();
    expect(robotList!.includes(cell), `${msg || ""} Cell ${cell} owned by ${owner} but not in byRobot list`).toBe(true);
  }

  // Check: every robot in byRobot has all its cells in cells with correct owner
  for (const [robot, robotList] of byRobot) {
    for (const cell of robotList) {
      expect(cells.get(cell), `${msg || ""} Robot ${robot} holds ${cell} but cells map says ${cells.get(cell)}`).toBe(robot);
    }
  }
}

describe("ReservationTable", () => {
  it("should claim an empty list and return empty", () => {
    const table = new ReservationTable();
    const robot: RobotId = "r1";
    const result = table.claim(robot, []);
    expect(result).toEqual([]);
  });

  it("should claim a single cell for a robot", () => {
    const table = new ReservationTable();
    const robot: RobotId = "r1";
    const cells: CellKey[] = ["0:0"];
    const result = table.claim(robot, cells);
    expect(result).toEqual(["0:0"]);
    expect(table.owner("0:0")).toBe(robot);
  });

  it("should claim a sequence of cells", () => {
    const table = new ReservationTable();
    const robot: RobotId = "r1";
    const cells: CellKey[] = ["0:0", "1:0", "2:0"];
    const result = table.claim(robot, cells);
    expect(result).toEqual(["0:0", "1:0", "2:0"]);
    expect(table.owner("0:0")).toBe(robot);
    expect(table.owner("1:0")).toBe(robot);
    expect(table.owner("2:0")).toBe(robot);
  });

  it("should stop prefix grant at first foreign-owned cell", () => {
    const table = new ReservationTable();
    const r1: RobotId = "r1";
    const r2: RobotId = "r2";

    // r1 claims first 2 cells
    table.claim(r1, ["0:0", "1:0", "2:0"]);

    // r2 tries to claim starting from 0:0, but should stop at first cell (which is owned by r1)
    const result = table.claim(r2, ["0:0", "1:0", "2:0"]);
    expect(result).toEqual([]); // No cells granted because first cell is foreign

    // Only r1 should own cells
    expect(table.owner("0:0")).toBe(r1);
    expect(table.owner("1:0")).toBe(r1);
    expect(table.owner("2:0")).toBe(r1);
  });

  it("should claim a prefix when later cells are foreign", () => {
    const table = new ReservationTable();
    const r1: RobotId = "r1";
    const r2: RobotId = "r2";

    // r1 claims 3 cells
    table.claim(r1, ["0:0", "1:0", "2:0"]);

    // r2 tries to claim 5 cells, but should stop at cell that r1 owns (2:0)
    const result = table.claim(r2, ["3:0", "4:0", "0:0", "1:0", "2:0"]);
    expect(result).toEqual(["3:0", "4:0"]); // Granted prefix

    expect(table.owner("3:0")).toBe(r2);
    expect(table.owner("4:0")).toBe(r2);
    expect(table.owner("0:0")).toBe(r1); // Still owned by r1
  });

  it("should release cells strictly behind current position", () => {
    const table = new ReservationTable();
    const robot: RobotId = "r1";

    // Claim cells
    table.claim(robot, ["0:0", "1:0", "2:0", "3:0"]);

    // Release everything behind "2:0"
    table.release(robot, "2:0");

    // Cells behind (0:0, 1:0) should be freed
    expect(table.owner("0:0")).toBeUndefined();
    expect(table.owner("1:0")).toBeUndefined();
    // Current and beyond should still be owned
    expect(table.owner("2:0")).toBe(robot);
    expect(table.owner("3:0")).toBe(robot);
  });

  it("should be no-op when releasing with current not in robot's list", () => {
    const table = new ReservationTable();
    const robot: RobotId = "r1";

    table.claim(robot, ["0:0", "1:0", "2:0"]);

    // Try to release with a cell the robot doesn't have
    table.release(robot, "5:5");

    // All cells should still be owned
    expect(table.owner("0:0")).toBe(robot);
    expect(table.owner("1:0")).toBe(robot);
    expect(table.owner("2:0")).toBe(robot);
  });

  it("should support releaseAll to free all robot's cells", () => {
    const table = new ReservationTable();
    const robot: RobotId = "r1";

    table.claim(robot, ["0:0", "1:0", "2:0", "3:0"]);

    // Release all cells
    table.releaseAll(robot);

    expect(table.owner("0:0")).toBeUndefined();
    expect(table.owner("1:0")).toBeUndefined();
    expect(table.owner("2:0")).toBeUndefined();
    expect(table.owner("3:0")).toBeUndefined();
  });

  it("should handle double-claim of own cells (idempotent)", () => {
    const table = new ReservationTable();
    const robot: RobotId = "r1";

    // First claim
    const result1 = table.claim(robot, ["0:0", "1:0", "2:0"]);
    expect(result1).toEqual(["0:0", "1:0", "2:0"]);

    // Second claim of same cells
    const result2 = table.claim(robot, ["0:0", "1:0", "2:0"]);
    expect(result2).toEqual(["0:0", "1:0", "2:0"]);

    expect(table.owner("0:0")).toBe(robot);
    expect(table.owner("1:0")).toBe(robot);
    expect(table.owner("2:0")).toBe(robot);
  });

  it("should extend claim when re-claiming with additional cells", () => {
    const table = new ReservationTable();
    const robot: RobotId = "r1";

    // First claim
    table.claim(robot, ["0:0", "1:0"]);

    // Re-claim with extended path
    const result = table.claim(robot, ["0:0", "1:0", "2:0", "3:0"]);
    expect(result).toEqual(["0:0", "1:0", "2:0", "3:0"]);

    expect(table.owner("2:0")).toBe(robot);
    expect(table.owner("3:0")).toBe(robot);
  });

  it("should handle interleaved claims of two robots", () => {
    const table = new ReservationTable();
    const r1: RobotId = "r1";
    const r2: RobotId = "r2";

    // r1 claims first path
    const r1_claim1 = table.claim(r1, ["0:0", "1:0", "2:0"]);
    expect(r1_claim1).toEqual(["0:0", "1:0", "2:0"]);

    // r2 tries to claim from different start
    const r2_claim1 = table.claim(r2, ["3:0", "4:0", "5:0"]);
    expect(r2_claim1).toEqual(["3:0", "4:0", "5:0"]);

    // r1 tries to extend its claim but stops at r2's cells
    const r1_claim2 = table.claim(r1, ["0:0", "1:0", "2:0", "3:0", "4:0"]);
    expect(r1_claim2).toEqual(["0:0", "1:0", "2:0"]); // Stops at r2's "3:0"

    // r2 should still own its cells
    expect(table.owner("3:0")).toBe(r2);
    expect(table.owner("4:0")).toBe(r2);
    expect(table.owner("5:0")).toBe(r2);
  });

  it("should release only cells behind current, not current itself", () => {
    const table = new ReservationTable();
    const robot: RobotId = "r1";

    table.claim(robot, ["0:0", "1:0", "2:0", "3:0", "4:0"]);

    // Release with current at "2:0"
    table.release(robot, "2:0");

    // Check that cells strictly behind are freed
    expect(table.owner("0:0")).toBeUndefined();
    expect(table.owner("1:0")).toBeUndefined();
    // Current and onwards should remain
    expect(table.owner("2:0")).toBe(robot);
    expect(table.owner("3:0")).toBe(robot);
    expect(table.owner("4:0")).toBe(robot);
  });

  it("should handle release when current is first cell", () => {
    const table = new ReservationTable();
    const robot: RobotId = "r1";

    table.claim(robot, ["0:0", "1:0", "2:0"]);

    // Release with current at first cell (nothing behind it)
    table.release(robot, "0:0");

    // All cells should still be owned (nothing behind 0:0)
    expect(table.owner("0:0")).toBe(robot);
    expect(table.owner("1:0")).toBe(robot);
    expect(table.owner("2:0")).toBe(robot);
  });

  it("should handle releaseAll on non-existent robot (no-op)", () => {
    const table = new ReservationTable();
    const r1: RobotId = "r1";
    const r2: RobotId = "r2";

    table.claim(r1, ["0:0", "1:0"]);

    // releaseAll on a robot that has no claims
    table.releaseAll(r2);

    // r1's cells should be unaffected
    expect(table.owner("0:0")).toBe(r1);
    expect(table.owner("1:0")).toBe(r1);
  });

  it("should track ownership correctly with multiple operations", () => {
    const table = new ReservationTable();
    const r1: RobotId = "r1";
    const r2: RobotId = "r2";

    // r1 claims
    table.claim(r1, ["0:0", "1:0", "2:0"]);
    expect(table.owner("1:0")).toBe(r1);

    // r1 releases behind 2:0
    table.release(r1, "2:0");
    expect(table.owner("0:0")).toBeUndefined();
    expect(table.owner("1:0")).toBeUndefined();
    expect(table.owner("2:0")).toBe(r1);

    // r2 can now claim earlier cells
    const r2_result = table.claim(r2, ["0:0", "1:0"]);
    expect(r2_result).toEqual(["0:0", "1:0"]);
    expect(table.owner("0:0")).toBe(r2);
    expect(table.owner("1:0")).toBe(r2);
    assertConsistent(table, "after multi-op sequence");
  });

  it("should free non-requested cells when re-claiming shorter path (non-superset)", () => {
    const table = new ReservationTable();
    const robot: RobotId = "r1";

    // First claim: r1 owns [A, B, C, D]
    table.claim(robot, ["0:0", "1:0", "2:0", "3:0"]);
    expect(table.owner("0:0")).toBe(robot);
    expect(table.owner("1:0")).toBe(robot);
    expect(table.owner("2:0")).toBe(robot);
    expect(table.owner("3:0")).toBe(robot);
    assertConsistent(table, "after initial claim");

    // Re-claim shorter path: r1 now only wants [B, C]
    // This should free [A, D]
    const result = table.claim(robot, ["1:0", "2:0"]);
    expect(result).toEqual(["1:0", "2:0"]);

    // Old cells outside the new claim should be freed
    expect(table.owner("0:0")).toBeUndefined();
    expect(table.owner("3:0")).toBeUndefined();
    // New claim cells should still be owned
    expect(table.owner("1:0")).toBe(robot);
    expect(table.owner("2:0")).toBe(robot);
    assertConsistent(table, "after non-superset re-claim");
  });

  it("should dedupe path revisits and release orphaned cells", () => {
    const table = new ReservationTable();
    const robot: RobotId = "r1";

    // Claim a path with duplicate cell [A, B, C, B]
    // Should dedupe to [A, B, C] keeping first B
    const result = table.claim(robot, ["0:0", "1:0", "2:0", "1:0"]);
    expect(result).toEqual(["0:0", "1:0", "2:0"]);

    // All cells should be owned exactly once
    expect(table.owner("0:0")).toBe(robot);
    expect(table.owner("1:0")).toBe(robot);
    expect(table.owner("2:0")).toBe(robot);
    assertConsistent(table, "after deduped claim");

    // Re-claim with a different duplicate pattern
    const result2 = table.claim(robot, ["0:0", "2:0", "1:0"]);
    // Prefix grant stops at first cell (0:0 owned), then 2:0 owned, then 1:0 owned
    // But the order changed, so result should be [0:0, 2:0, 1:0] minus cells that become foreign
    // Actually: [0:0, 2:0, 1:0] all belong to robot, so grant = [0:0, 2:0, 1:0]
    // But 1:0 was previously at index 1 and now at index 2 (reordered)
    // The new claim is [0:0, 2:0, 1:0] - should grant all three since robot owns them
    expect(result2).toEqual(["0:0", "2:0", "1:0"]);
    assertConsistent(table, "after reordered re-claim");
  });

  it("consistency is maintained across all operations", () => {
    const table = new ReservationTable();
    const r1: RobotId = "r1";
    const r2: RobotId = "r2";

    // Series of operations
    table.claim(r1, ["0:0", "1:0", "2:0", "3:0", "4:0"]);
    assertConsistent(table, "r1 initial claim");

    table.claim(r2, ["5:0", "6:0"]);
    assertConsistent(table, "r2 claim");

    table.release(r1, "2:0");
    assertConsistent(table, "r1 release");

    table.claim(r1, ["1:0", "2:0"]);
    assertConsistent(table, "r1 re-claim (shortening)");

    table.claim(r2, ["0:0", "5:0", "6:0"]);
    assertConsistent(table, "r2 claim (getting freed cell)");

    table.releaseAll(r1);
    assertConsistent(table, "r1 releaseAll");

    expect(table.owner("1:0")).toBeUndefined();
    expect(table.owner("2:0")).toBeUndefined();
  });
});
