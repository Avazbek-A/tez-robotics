import { describe, it, expect } from "vitest";
import { WarehouseMap } from "../src/map.js";
import type { GridPos } from "@tez/shared";

describe("WarehouseMap", () => {
  // Test data: 3x3 grid for testing
  const testGrid = {
    nodes: [
      { id: "n0_0", pos: { x: 0, y: 0 }, charger: true },
      { id: "n1_0", pos: { x: 1, y: 0 } },
      { id: "n2_0", pos: { x: 2, y: 0 } },
      { id: "n0_1", pos: { x: 0, y: 1 } },
      { id: "n1_1", pos: { x: 1, y: 1 } },
      { id: "n2_1", pos: { x: 2, y: 1 } },
      { id: "n0_2", pos: { x: 0, y: 2 } },
      { id: "n1_2", pos: { x: 1, y: 2 } },
      { id: "n2_2", pos: { x: 2, y: 2 } },
    ],
    edges: [
      // Row 0
      { from: "n0_0", to: "n1_0", bidirectional: true },
      { from: "n1_0", to: "n2_0", bidirectional: true },
      // Row 1
      { from: "n0_1", to: "n1_1", bidirectional: true },
      { from: "n1_1", to: "n2_1", bidirectional: true },
      // Row 2
      { from: "n0_2", to: "n1_2", bidirectional: true },
      { from: "n1_2", to: "n2_2", bidirectional: true },
      // Columns
      { from: "n0_0", to: "n0_1", bidirectional: true },
      { from: "n0_1", to: "n0_2", bidirectional: true },
      { from: "n1_0", to: "n1_1", bidirectional: true },
      { from: "n1_1", to: "n1_2", bidirectional: true },
      { from: "n2_0", to: "n2_1", bidirectional: true },
      { from: "n2_1", to: "n2_2", bidirectional: true },
    ],
  };

  it("should load from JSON and round-trip", () => {
    const map = WarehouseMap.fromJSON(testGrid);
    expect(map).toBeDefined();
    expect(map.nodeIds.length).toBe(9);
    expect(map.node("n0_0").charger).toBe(true);
    expect(map.node("n1_1").charger).toBeUndefined();
  });

  it("should return correct number of neighbors for corner nodes", () => {
    const map = WarehouseMap.fromJSON(testGrid);
    // Corner node n0_0 has 2 neighbors
    expect(map.neighbors("n0_0").length).toBe(2);
    expect(map.neighbors("n0_0")).toContain("n1_0");
    expect(map.neighbors("n0_0")).toContain("n0_1");
  });

  it("should return correct number of neighbors for center nodes", () => {
    const map = WarehouseMap.fromJSON(testGrid);
    // Center node n1_1 has 4 neighbors
    expect(map.neighbors("n1_1").length).toBe(4);
    expect(map.neighbors("n1_1")).toContain("n0_1");
    expect(map.neighbors("n1_1")).toContain("n2_1");
    expect(map.neighbors("n1_1")).toContain("n1_0");
    expect(map.neighbors("n1_1")).toContain("n1_2");
  });

  it("should calculate distance via BFS", () => {
    const map = WarehouseMap.fromJSON(testGrid);
    // Distance from n0_0 to n2_0 is 2
    expect(map.distance("n0_0", "n2_0")).toBe(2);
    // Distance from n0_0 to n2_1 is 3
    expect(map.distance("n0_0", "n2_1")).toBe(3);
    // Distance to self is 0
    expect(map.distance("n0_0", "n0_0")).toBe(0);
  });

  it("should return Infinity for unreachable nodes", () => {
    // Create a disconnected graph
    const disconnected = {
      nodes: [
        { id: "n0_0", pos: { x: 0, y: 0 } },
        { id: "n1_0", pos: { x: 1, y: 0 } },
        { id: "n5_5", pos: { x: 5, y: 5 } },
      ],
      edges: [
        { from: "n0_0", to: "n1_0", bidirectional: true },
        // n5_5 is isolated
      ],
    };
    const map = WarehouseMap.fromJSON(disconnected);
    expect(map.distance("n0_0", "n5_5")).toBe(Infinity);
  });

  it("should throw on orphan edges", () => {
    const orphanEdge = {
      nodes: [{ id: "n0_0", pos: { x: 0, y: 0 } }],
      edges: [{ from: "n0_0", to: "nonexistent", bidirectional: true }],
    };
    expect(() => WarehouseMap.fromJSON(orphanEdge)).toThrow();
  });

  it("should generate grid with static helper", () => {
    const grid = WarehouseMap.grid(3, 2);
    expect(grid.nodes.length).toBe(6);
    expect(grid.nodes[0].id).toBe("n0_0");
    expect(grid.nodes[0].pos).toEqual({ x: 0, y: 0 });
    // Check chargers at x=0
    expect(grid.nodes[0].charger).toBe(true);
    expect(grid.nodes[3].charger).toBe(true);
    // Check non-chargers elsewhere
    expect(grid.nodes[1].charger).toBeUndefined();
  });

  it("should find nearest node by position", () => {
    const map = WarehouseMap.fromJSON(testGrid);
    // Position at (0.1, 0.1) should be nearest to n0_0
    const nearest = map.nearestNode({ x: 0.1, y: 0.1 });
    expect(nearest).toBe("n0_0");
  });
});
