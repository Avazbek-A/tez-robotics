import { describe, it, expect } from "vitest";
import { cellKey } from "../src/types.js";

describe("types", () => {
  it("cellKey formats grid position", () => {
    expect(cellKey({ x: 3, y: 7 })).toBe("3:7");
  });
});
