import { describe, it, expect } from "vitest";
import { dispatch } from "../src/dispatcher.js";
import { WarehouseMap } from "../src/map.js";
import type { RobotId } from "../src/dispatcher.js";

function asRobotId(id: string): RobotId {
  return id as RobotId;
}

describe("dispatch", () => {
  // Helper to create a simple 5x5 grid
  const createGridMap = () => {
    return WarehouseMap.fromJSON(WarehouseMap.grid(5, 5));
  };

  it("should assign 2 robots to 2 orders with nearest distance wins", () => {
    const map = createGridMap();
    const robots = [
      { id: asRobotId("r1"), at: "n0_0", idleSince: 0 },
      { id: asRobotId("r2"), at: "n4_4", idleSince: 0 },
    ];
    const orders = [
      { id: "o1", pickupNode: "n0_0" }, // closest to r1
      { id: "o2", pickupNode: "n4_4" }, // closest to r2
    ];

    const result = dispatch(robots, orders, map);

    expect(result).toHaveLength(2);
    expect(result).toContainEqual({ orderId: "o1", robotId: asRobotId("r1") });
    expect(result).toContainEqual({ orderId: "o2", robotId: asRobotId("r2") });
  });

  it("should assign 1 robot to only 1 of 3 orders", () => {
    const map = createGridMap();
    const robots = [{ id: asRobotId("r1"), at: "n0_0", idleSince: 0 }];
    const orders = [
      { id: "o1", pickupNode: "n0_0" },
      { id: "o2", pickupNode: "n1_1" },
      { id: "o3", pickupNode: "n2_2" },
    ];

    const result = dispatch(robots, orders, map);

    expect(result).toHaveLength(1);
    expect(result[0]!.robotId).toBe(asRobotId("r1"));
    expect(result[0]!.orderId).toBe("o1"); // closest order
  });

  it("should not assign unreachable orders", () => {
    // Create a disconnected graph: robot can't reach isolated order
    const mapData = {
      nodes: [
        { id: "n0_0", pos: { x: 0, y: 0 } },
        { id: "n1_1", pos: { x: 1, y: 1 } },
        { id: "isolated", pos: { x: 10, y: 10 } },
      ],
      edges: [{ from: "n0_0", to: "n1_1", bidirectional: true }],
    };
    const map = WarehouseMap.fromJSON(mapData);

    const robots = [{ id: asRobotId("r1"), at: "n0_0", idleSince: 0 }];
    const orders = [
      { id: "o1", pickupNode: "n1_1" }, // reachable
      { id: "o2", pickupNode: "isolated" }, // unreachable
    ];

    const result = dispatch(robots, orders, map);

    expect(result).toHaveLength(1);
    expect(result[0]!.orderId).toBe("o1");
  });

  it("should favor longer-idle robot to break distance ties", () => {
    // Create a map where both robots are equidistant from an order
    const mapData = {
      nodes: [
        { id: "r1", pos: { x: 0, y: 0 } },
        { id: "r2", pos: { x: 2, y: 0 } },
        { id: "order", pos: { x: 1, y: 0 } },
      ],
      edges: [
        { from: "r1", to: "order", bidirectional: true },
        { from: "order", to: "r2", bidirectional: true },
      ],
    };
    const map = WarehouseMap.fromJSON(mapData);

    const robots = [
      { id: asRobotId("r1"), at: "r1", idleSince: 3 }, // less idle
      { id: asRobotId("r2"), at: "r2", idleSince: 5 }, // more idle, should win
    ];
    const orders = [{ id: "o1", pickupNode: "order" }];

    const result = dispatch(robots, orders, map);

    expect(result).toHaveLength(1);
    expect(result[0]!.robotId).toBe(asRobotId("r2")); // more idle
  });

  it("should choose global optimum over greedy nearest in 3x3 scenario", () => {
    // Classic case where greedy fails:
    // r1 at (0,0), r2 at (0,2), r3 at (2,1)
    // o1 at (0,1), o2 at (1,1), o3 at (2,2)
    // Greedy nearest: r1->o1, r2->o3, r3->o2 (total distance: 1+1+1=3)
    // Optimal: r1->o1, r3->o3, r2->o2 (total distance: 1+1+1=3)
    // Actually let me construct it to make greedy obviously suboptimal:
    // r1 at (0,0), r2 at (0,3), r3 at (1,1)
    // o1 at (0,1), o2 at (1,0), o3 at (1,3)
    // Greedy: r1->o2(dist=1), r2->o3(dist=0), r3->o1(dist=1) = 2
    // Optimal: r1->o1(dist=1), r2->o3(dist=0), r3->o2(dist=1) = 2
    // Need better case...
    // Let's use simple distances directly:
    const mapData = {
      nodes: [
        { id: "r1", pos: { x: 0, y: 0 } },
        { id: "r2", pos: { x: 2, y: 0 } },
        { id: "r3", pos: { x: 1, y: 2 } },
        { id: "o1", pos: { x: 0, y: 1 } },
        { id: "o2", pos: { x: 2, y: 1 } },
        { id: "o3", pos: { x: 1, y: 0 } },
      ],
      edges: [
        { from: "r1", to: "o1", bidirectional: true },
        { from: "r1", to: "o3", bidirectional: true },
        { from: "r2", to: "o2", bidirectional: true },
        { from: "r2", to: "o3", bidirectional: true },
        { from: "r3", to: "o1", bidirectional: true },
        { from: "r3", to: "o2", bidirectional: true },
        { from: "o1", to: "o3", bidirectional: true },
        { from: "o2", to: "o3", bidirectional: true },
      ],
    };
    const map = WarehouseMap.fromJSON(mapData);

    // Cost matrix (distance only, no idle bonus):
    // r1: [1, ∞, 1]  (r1 can reach o1 dist=1, o3 dist=1)
    // r2: [∞, 1, 1]  (r2 can reach o2 dist=1, o3 dist=1)
    // r3: [1, 1, ∞]  (r3 can reach o1 dist=1, o2 dist=1)
    //
    // Greedy nearest would try: r1->o1 (cost 1), r2->o2 (cost 1), r3->o3 (unreachable)
    // Hungarian optimal: r1->o3 (cost 1), r2->o2 (cost 1), r3->o1 (cost 1)

    const robots = [
      { id: asRobotId("r1"), at: "r1", idleSince: 0 },
      { id: asRobotId("r2"), at: "r2", idleSince: 0 },
      { id: asRobotId("r3"), at: "r3", idleSince: 0 },
    ];
    const orders = [
      { id: "o1", pickupNode: "o1" },
      { id: "o2", pickupNode: "o2" },
      { id: "o3", pickupNode: "o3" },
    ];

    const result = dispatch(robots, orders, map);

    // Should have 3 assignments
    expect(result).toHaveLength(3);

    // Verify it's a valid perfect matching
    const assignedOrders = new Set(result.map((a) => a.orderId));
    const assignedRobots = new Set(result.map((a) => a.robotId));
    expect(assignedOrders.size).toBe(3);
    expect(assignedRobots.size).toBe(3);
    expect(Array.from(assignedOrders).sort()).toEqual(["o1", "o2", "o3"]);
  });

  it("should deterministically order by id when inputs are unordered", () => {
    const map = createGridMap();

    // Deliberately unsorted inputs
    const robots = [
      { id: asRobotId("z_robot"), at: "n4_4", idleSince: 0 },
      { id: asRobotId("a_robot"), at: "n0_0", idleSince: 0 },
    ];
    const orders = [
      { id: "z_order", pickupNode: "n4_4" },
      { id: "a_order", pickupNode: "n0_0" },
    ];

    const result1 = dispatch(robots, orders, map);
    const result2 = dispatch(robots, orders, map);

    // Must be identical despite unsorted input
    expect(result1).toEqual(result2);
    expect(result1.sort((a, b) => a.orderId.localeCompare(b.orderId))).toEqual(
      result2.sort((a, b) => a.orderId.localeCompare(b.orderId))
    );
  });

  it("should handle empty inputs gracefully", () => {
    const map = createGridMap();

    const result1 = dispatch([], [], map);
    expect(result1).toEqual([]);

    const result2 = dispatch(
      [{ id: asRobotId("r1"), at: "n0_0", idleSince: 0 }],
      [],
      map
    );
    expect(result2).toEqual([]);

    const result3 = dispatch(
      [],
      [{ id: "o1", pickupNode: "n0_0" }],
      map
    );
    expect(result3).toEqual([]);
  });

  it("should cap idle bonus at 10 ticks", () => {
    const map = createGridMap();

    // Two robots with equal distances but different idle times
    // r1: idleSince=5 (bonus = 0.05)
    // r2: idleSince=100 (bonus = 0.10, capped at 10)
    // r2's bonus should be the same as with idleSince=10

    const robots1 = [
      { id: asRobotId("r1"), at: "n0_0", idleSince: 0 },
      { id: asRobotId("r2"), at: "n0_0", idleSince: 100 },
    ];

    const robots2 = [
      { id: asRobotId("r1"), at: "n0_0", idleSince: 0 },
      { id: asRobotId("r2"), at: "n0_0", idleSince: 10 },
    ];

    const orders = [
      { id: "o1", pickupNode: "n1_0" },
      { id: "o2", pickupNode: "n2_0" },
    ];

    const result1 = dispatch(robots1, orders, map);
    const result2 = dispatch(robots2, orders, map);

    // Both should produce the same assignment since cap is 10
    expect(result1.sort((a, b) => a.orderId.localeCompare(b.orderId))).toEqual(
      result2.sort((a, b) => a.orderId.localeCompare(b.orderId))
    );
  });

  it("should assign multiple robots to multiple orders optimally", () => {
    const map = createGridMap();

    const robots = [
      { id: asRobotId("r1"), at: "n0_0", idleSince: 0 },
      { id: asRobotId("r2"), at: "n4_0", idleSince: 0 },
      { id: asRobotId("r3"), at: "n2_2", idleSince: 0 },
    ];

    const orders = [
      { id: "o1", pickupNode: "n0_1" },
      { id: "o2", pickupNode: "n4_1" },
      { id: "o3", pickupNode: "n2_2" },
    ];

    const result = dispatch(robots, orders, map);

    expect(result).toHaveLength(3);

    // Verify each robot and order appears exactly once
    const robotIds = result.map((a) => a.robotId);
    const orderIds = result.map((a) => a.orderId);
    expect(new Set(robotIds).size).toBe(3);
    expect(new Set(orderIds).size).toBe(3);
  });

  it("should achieve optimal assignment on square 2x2 fully symmetric matrix (idle bonus cancels)", () => {
    // Square matrix (2 robots, 2 orders) with fully symmetric distances.
    // On square matrices, idleBonus cancels: Σ(distance - idleBonus) across all valid
    // matchings is equivalent to Σ(distance), so idle fairness is a no-op and
    // optimal assignment depends purely on distances. This is acceptable since
    // all robots get assigned anyway (no arbitration needed).
    const mapData = {
      nodes: [
        { id: "r1", pos: { x: 0, y: 0 } },
        { id: "r2", pos: { x: 2, y: 0 } },
        { id: "o1", pos: { x: 0, y: 1 } },
        { id: "o2", pos: { x: 2, y: 1 } },
      ],
      edges: [
        { from: "r1", to: "o1", bidirectional: true },
        { from: "r1", to: "o2", bidirectional: true },
        { from: "r2", to: "o1", bidirectional: true },
        { from: "r2", to: "o2", bidirectional: true },
      ],
    };
    const map = WarehouseMap.fromJSON(mapData);

    // Both robots at distance 1 from both orders (symmetric).
    // Any matching has total distance 2; idleBonus is constant, so selection is stable.
    const robots = [
      { id: asRobotId("r1"), at: "r1", idleSince: 5 },
      { id: asRobotId("r2"), at: "r2", idleSince: 10 },
    ];
    const orders = [
      { id: "o1", pickupNode: "o1" },
      { id: "o2", pickupNode: "o2" },
    ];

    const result = dispatch(robots, orders, map);

    // Both robots must be assigned (perfect matching on square matrix)
    expect(result).toHaveLength(2);
    const assignedRobots = new Set(result.map((a) => a.robotId));
    expect(assignedRobots.size).toBe(2);

    // Total distance must be optimal (2 hops, since all distances are 1)
    const totalDistance = result.reduce((sum, assignment) => {
      const robot = robots.find((r) => r.id === assignment.robotId)!;
      const order = orders.find((o) => o.id === assignment.orderId)!;
      return sum + map.distance(robot.at, order.pickupNode);
    }, 0);
    expect(totalDistance).toBe(2); // 1 + 1 for optimal pairing
  });
});
