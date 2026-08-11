import { describe, expect, it } from "vitest";
import { CELL, gridToPx } from "../src/map/coords";

describe("coords", () => {
  it("exports the cell size used to scale grid units to pixels", () => {
    expect(CELL).toBe(48);
  });

  it("maps grid origin to pixel origin", () => {
    expect(gridToPx({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });

  it("scales grid units to pixels by CELL, y-down (no axis flip)", () => {
    expect(gridToPx({ x: 1, y: 0 })).toEqual({ x: 48, y: 0 });
    expect(gridToPx({ x: 0, y: 1 })).toEqual({ x: 0, y: 48 });
    expect(gridToPx({ x: 3, y: 5 })).toEqual({ x: 144, y: 240 });
  });

  it("handles fractional grid positions", () => {
    expect(gridToPx({ x: 1.5, y: 2.25 })).toEqual({ x: 72, y: 108 });
  });

  it("handles negative grid positions", () => {
    expect(gridToPx({ x: -2, y: -1 })).toEqual({ x: -96, y: -48 });
  });
});
