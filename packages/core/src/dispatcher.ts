import { hungarianAssignment } from "./vendor/munkres.js";
import type { WarehouseMap } from "./map.js";

export type RobotId = string & { readonly __brand: "RobotId" };

export interface Assignment {
  orderId: string;
  robotId: RobotId;
}

interface IdleRobot {
  id: RobotId;
  at: string;
  idleSince: number;
}

interface Order {
  id: string;
  pickupNode: string;
}

/**
 * Calculates idle bonus (small tie-breaker favoring longer-idle robots).
 * Capped at 10 ticks, multiplied by 0.01 to keep as tie-breaker only.
 */
function idleBonus(idleSince: number): number {
  const IDLE_CAP = 10;
  const capped = Math.min(idleSince, IDLE_CAP);
  return capped * 0.01;
}

/**
 * Dispatches pending orders to idle robots using Hungarian (Kuhn–Munkres) algorithm.
 * Finds the minimum-cost assignment of orders to robots.
 *
 * Cost = distance(robot, order) - idleBonus(robot)
 * where idleBonus favors longer-idle robots as tie-breaker.
 *
 * Note on idleBonus behavior:
 * - On rectangular matrices (robots > orders): idleBonus meaningfully affects assignment,
 *   allowing fair load balancing—robots with longer idle times are preferred for available orders.
 * - On square matrices (robots ≡ orders): idleBonus mathematically cancels across all valid
 *   matchings (Σ idleBonus is constant), so assignment is determined purely by distance.
 *   This is acceptable—all robots are assigned anyway, so idle fairness has no arbitration role.
 *
 * Unreachable pairs cost 1e9 and are filtered from the result.
 */
export function dispatch(
  idleRobots: IdleRobot[],
  pending: Order[],
  map: WarehouseMap
): Assignment[] {
  if (idleRobots.length === 0 || pending.length === 0) {
    return [];
  }

  // Sort for determinism
  const sortedRobots = [...idleRobots].sort((a, b) => a.id.localeCompare(b.id));
  const sortedOrders = [...pending].sort((a, b) => a.id.localeCompare(b.id));

  // Build cost matrix
  const costMatrix: number[][] = [];
  for (const robot of sortedRobots) {
    const row: number[] = [];
    for (const order of sortedOrders) {
      const distance = map.distance(robot.at, order.pickupNode);
      const bonus = idleBonus(robot.idleSince);

      // Mark unreachable pairs with high cost
      if (!isFinite(distance)) {
        row.push(1e9);
      } else {
        row.push(distance - bonus);
      }
    }
    costMatrix.push(row);
  }

  // Run Hungarian algorithm
  const assignments = hungarianAssignment(costMatrix);

  // Filter out unreachable pairs (cost >= 1e9 / 2)
  const result: Assignment[] = [];
  for (const [robotIdx, orderIdx] of assignments) {
    if (robotIdx < sortedRobots.length && orderIdx < sortedOrders.length) {
      const cost = costMatrix[robotIdx]![orderIdx]!;
      if (cost < 1e9 / 2) {
        result.push({
          orderId: sortedOrders[orderIdx]!.id,
          robotId: sortedRobots[robotIdx]!.id,
        });
      }
    }
  }

  return result;
}
