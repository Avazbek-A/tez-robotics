import type { RobotId } from "./dispatcher.js";

export type OrderStatus = "queued" | "dispatched" | "underway" | "completed" | "failed" | "canceled";

export interface HistoryEntry {
  at: string;
  from: OrderStatus;
  to: OrderStatus;
  reason?: string;
}

export interface TransportOrder {
  id: string;
  pickupNode: string;
  dropNode: string;
  status: OrderStatus;
  robotId?: RobotId;
  retries: number;
  createdAt: string;
  history: HistoryEntry[];
}

/**
 * Custom error for illegal state transitions.
 */
export class IllegalTransition extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IllegalTransition";
  }
}

/**
 * OrderBook manages transport orders and their state transitions.
 *
 * Valid transitions:
 * - queued → dispatched → underway → completed (normal path)
 * - any non-terminal → canceled
 * - dispatched|underway → queued (requeue, increments retries)
 * - requeue with retries ≥ 3 → failed instead
 *
 * Injects a clock function for deterministic testing.
 */
export class OrderBook {
  private orders: Map<string, TransportOrder> = new Map();
  private counter: number = 0;
  private clock: () => string;

  constructor(clock?: () => string) {
    this.clock = clock || (() => new Date().toISOString());
  }

  /**
   * Create a new transport order with queued status.
   */
  create(pickupNode: string, dropNode: string): TransportOrder {
    this.counter++;
    const id = `ord-${String(this.counter).padStart(5, "0")}`;
    const now = this.clock();

    const order: TransportOrder = {
      id,
      pickupNode,
      dropNode,
      status: "queued",
      retries: 0,
      createdAt: now,
      history: [],
    };

    this.orders.set(id, order);
    return order;
  }

  /**
   * Transition an order to a new status.
   * Optionally set robotId when transitioning to dispatched.
   *
   * @throws IllegalTransition if the transition is not allowed
   */
  transition(
    id: string,
    to: OrderStatus,
    reason?: string,
    robotId?: RobotId
  ): TransportOrder {
    const order = this.orders.get(id);
    if (!order) {
      throw new IllegalTransition(`Order not found: ${id}`);
    }

    const from = order.status;

    // Check if transition is legal
    if (!this.isLegalTransition(from, to)) {
      throw new IllegalTransition(
        `Illegal transition: ${from} → ${to}`
      );
    }

    // Perform the transition
    order.status = to;

    // Set or clear robotId based on status
    if (to === "dispatched" && robotId) {
      order.robotId = robotId;
    } else if (to === "queued") {
      // Clear robotId when requeuing
      order.robotId = undefined;
    }

    // Record history
    order.history.push({
      at: this.clock(),
      from,
      to,
      reason,
    });

    return order;
  }

  /**
   * Requeue an order: dispatched|underway → queued (increments retries).
   * If retries ≥ 3, transition to failed instead.
   *
   * @throws IllegalTransition if requeue is not allowed from current status
   */
  requeue(id: string, reason: string): TransportOrder {
    const order = this.orders.get(id);
    if (!order) {
      throw new IllegalTransition(`Order not found: ${id}`);
    }

    const from = order.status;

    // Check if requeue is allowed from current status
    if (from !== "dispatched" && from !== "underway") {
      throw new IllegalTransition(
        `Cannot requeue from status: ${from}`
      );
    }

    order.retries++;

    // If retries >= 3, fail the order instead of requeuing
    if (order.retries >= 3) {
      order.status = "failed";
      order.robotId = undefined;
      order.history.push({
        at: this.clock(),
        from,
        to: "failed",
        reason,
      });
    } else {
      // Requeue to queued status
      order.status = "queued";
      order.robotId = undefined;
      order.history.push({
        at: this.clock(),
        from,
        to: "queued",
        reason,
      });
    }

    return order;
  }

  /**
   * Get all pending orders (queued, dispatched, or underway).
   */
  pending(): TransportOrder[] {
    return Array.from(this.orders.values()).filter(
      (order) =>
        order.status === "queued" ||
        order.status === "dispatched" ||
        order.status === "underway"
    );
  }

  /**
   * Find order assigned to a specific robot.
   */
  byRobot(robotId: RobotId): TransportOrder | undefined {
    return Array.from(this.orders.values()).find(
      (order) => order.robotId === robotId
    );
  }

  /**
   * Check if a transition is legal.
   */
  private isLegalTransition(from: OrderStatus, to: OrderStatus): boolean {
    // Terminal states (can't transition out)
    if (from === "completed" || from === "failed" || from === "canceled") {
      return false;
    }

    // Queued can go to dispatched or canceled
    if (from === "queued") {
      return to === "dispatched" || to === "canceled";
    }

    // Dispatched can go to underway or canceled
    if (from === "dispatched") {
      return to === "underway" || to === "canceled";
    }

    // Underway can go to completed or canceled
    if (from === "underway") {
      return to === "completed" || to === "canceled";
    }

    return false;
  }
}
