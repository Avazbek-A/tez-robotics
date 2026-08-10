import { describe, it, expect } from "vitest";
import { ReservationTable } from "../src/reservations.js";
import type { CellKey, RobotId } from "@tez/shared";

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
  });
});
