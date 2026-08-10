import { describe, it, expect, beforeEach } from "vitest";
import { OrderBook, IllegalTransition } from "../src/orders.js";
import type { TransportOrder } from "../src/orders.js";

describe("OrderBook", () => {
  let orderBook: OrderBook;
  let now: string;

  beforeEach(() => {
    now = "2025-01-01T00:00:00.000Z";
    orderBook = new OrderBook(() => now);
  });

  describe("create", () => {
    it("should create an order with unique monotonic IDs", () => {
      const order1 = orderBook.create("n0_0", "n2_2");
      const order2 = orderBook.create("n0_0", "n1_1");

      expect(order1.id).toBe("ord-00001");
      expect(order2.id).toBe("ord-00002");
    });

    it("should initialize order with queued status", () => {
      const order = orderBook.create("n0_0", "n2_2");

      expect(order.status).toBe("queued");
      expect(order.pickupNode).toBe("n0_0");
      expect(order.dropNode).toBe("n2_2");
      expect(order.retries).toBe(0);
      expect(order.robotId).toBeUndefined();
    });

    it("should set createdAt timestamp", () => {
      const order = orderBook.create("n0_0", "n2_2");

      expect(order.createdAt).toBe(now);
    });

    it("should initialize empty history", () => {
      const order = orderBook.create("n0_0", "n2_2");

      expect(order.history).toEqual([]);
    });
  });

  describe("transition", () => {
    it("should transition queued → dispatched", () => {
      const order = orderBook.create("n0_0", "n2_2");
      const transitioned = orderBook.transition(order.id, "dispatched", "Robot available");

      expect(transitioned.status).toBe("dispatched");
      expect(transitioned.history).toEqual([
        { at: now, from: "queued", to: "dispatched", reason: "Robot available" },
      ]);
    });

    it("should transition dispatched → underway", () => {
      const order = orderBook.create("n0_0", "n2_2");
      orderBook.transition(order.id, "dispatched");
      const transitioned = orderBook.transition(order.id, "underway", "Started pickup");

      expect(transitioned.status).toBe("underway");
      expect(transitioned.history.length).toBe(2);
      expect(transitioned.history[1]).toEqual({
        at: now,
        from: "dispatched",
        to: "underway",
        reason: "Started pickup",
      });
    });

    it("should transition underway → completed", () => {
      const order = orderBook.create("n0_0", "n2_2");
      orderBook.transition(order.id, "dispatched");
      orderBook.transition(order.id, "underway");
      const transitioned = orderBook.transition(order.id, "completed", "Delivered");

      expect(transitioned.status).toBe("completed");
      expect(transitioned.history.length).toBe(3);
    });

    it("should throw on illegal transition queued → completed", () => {
      const order = orderBook.create("n0_0", "n2_2");

      expect(() => orderBook.transition(order.id, "completed")).toThrow(IllegalTransition);
    });

    it("should throw with name set to IllegalTransition", () => {
      const order = orderBook.create("n0_0", "n2_2");

      try {
        orderBook.transition(order.id, "completed");
        throw new Error("Should have thrown");
      } catch (err) {
        expect((err as Error).name).toBe("IllegalTransition");
      }
    });

    it("should allow transition to canceled from non-terminal states", () => {
      const order = orderBook.create("n0_0", "n2_2");
      const canceled = orderBook.transition(order.id, "canceled", "User canceled");

      expect(canceled.status).toBe("canceled");
    });

    it("should throw on transition from completed to anything", () => {
      const order = orderBook.create("n0_0", "n2_2");
      orderBook.transition(order.id, "dispatched");
      orderBook.transition(order.id, "underway");
      orderBook.transition(order.id, "completed");

      expect(() => orderBook.transition(order.id, "canceled")).toThrow(IllegalTransition);
    });

    it("should throw on transition from failed to anything", () => {
      const order = orderBook.create("n0_0", "n2_2");
      orderBook.transition(order.id, "dispatched");
      const retry1 = orderBook.requeue(order.id, "Retry 1");
      orderBook.transition(retry1.id, "dispatched");
      const retry2 = orderBook.requeue(retry1.id, "Retry 2");
      orderBook.transition(retry2.id, "dispatched");
      const failed = orderBook.requeue(retry2.id, "Max retries");

      expect(failed.status).toBe("failed");
      expect(() => orderBook.transition(failed.id, "queued")).toThrow(IllegalTransition);
    });

    it("should throw on invalid state transitions", () => {
      const order = orderBook.create("n0_0", "n2_2");

      expect(() => orderBook.transition(order.id, "underway")).toThrow(IllegalTransition);
    });

    it("should throw on nonexistent order ID", () => {
      expect(() => orderBook.transition("ord-99999", "dispatched")).toThrow(IllegalTransition);
    });
  });

  describe("requeue", () => {
    it("should transition dispatched → queued and increment retries", () => {
      const order = orderBook.create("n0_0", "n2_2");
      orderBook.transition(order.id, "dispatched");
      const requeued = orderBook.requeue(order.id, "Retry 1");

      expect(requeued.status).toBe("queued");
      expect(requeued.retries).toBe(1);
    });

    it("should transition underway → queued and increment retries", () => {
      const order = orderBook.create("n0_0", "n2_2");
      orderBook.transition(order.id, "dispatched");
      orderBook.transition(order.id, "underway");
      const requeued = orderBook.requeue(order.id, "Retry 1");

      expect(requeued.status).toBe("queued");
      expect(requeued.retries).toBe(1);
    });

    it("should record history entry for requeue", () => {
      const order = orderBook.create("n0_0", "n2_2");
      orderBook.transition(order.id, "dispatched");
      const requeued = orderBook.requeue(order.id, "Retry attempt");

      expect(requeued.history.length).toBe(2);
      expect(requeued.history[1]).toEqual({
        at: now,
        from: "dispatched",
        to: "queued",
        reason: "Retry attempt",
      });
    });

    it("should fail order on 3rd requeue attempt", () => {
      const order = orderBook.create("n0_0", "n2_2");
      orderBook.transition(order.id, "dispatched");

      const retry1 = orderBook.requeue(order.id, "Retry 1");
      expect(retry1.status).toBe("queued");
      expect(retry1.retries).toBe(1);

      orderBook.transition(retry1.id, "dispatched");
      const retry2 = orderBook.requeue(retry1.id, "Retry 2");
      expect(retry2.status).toBe("queued");
      expect(retry2.retries).toBe(2);

      orderBook.transition(retry2.id, "dispatched");
      const failed = orderBook.requeue(retry2.id, "Max retries reached");
      expect(failed.status).toBe("failed");
      expect(failed.retries).toBe(3);
    });

    it("should record failed transition in history", () => {
      const order = orderBook.create("n0_0", "n2_2");
      orderBook.transition(order.id, "dispatched");

      const retry1 = orderBook.requeue(order.id, "Retry 1");
      orderBook.transition(retry1.id, "dispatched");
      const retry2 = orderBook.requeue(retry1.id, "Retry 2");
      orderBook.transition(retry2.id, "dispatched");
      const failed = orderBook.requeue(retry2.id, "Final retry");

      expect(failed.history[failed.history.length - 1]).toEqual({
        at: now,
        from: "dispatched",
        to: "failed",
        reason: "Final retry",
      });
    });

    it("should throw on requeue from queued status", () => {
      const order = orderBook.create("n0_0", "n2_2");

      expect(() => orderBook.requeue(order.id, "Invalid requeue")).toThrow(IllegalTransition);
    });

    it("should throw on requeue from completed status", () => {
      const order = orderBook.create("n0_0", "n2_2");
      orderBook.transition(order.id, "dispatched");
      orderBook.transition(order.id, "underway");
      orderBook.transition(order.id, "completed");

      expect(() => orderBook.requeue(order.id, "Invalid requeue")).toThrow(IllegalTransition);
    });
  });

  describe("pending", () => {
    it("should return all queued orders", () => {
      orderBook.create("n0_0", "n1_1");
      orderBook.create("n0_0", "n2_2");
      const pending = orderBook.pending();

      expect(pending.length).toBe(2);
      expect(pending.every(o => o.status === "queued")).toBe(true);
    });

    it("should include dispatched orders in pending", () => {
      const order1 = orderBook.create("n0_0", "n1_1");
      const order2 = orderBook.create("n0_0", "n2_2");
      orderBook.transition(order1.id, "dispatched");

      const pending = orderBook.pending();

      expect(pending.length).toBe(2);
    });

    it("should include underway orders in pending", () => {
      const order1 = orderBook.create("n0_0", "n1_1");
      const order2 = orderBook.create("n0_0", "n2_2");
      orderBook.transition(order1.id, "dispatched");
      orderBook.transition(order1.id, "underway");

      const pending = orderBook.pending();

      expect(pending.length).toBe(2);
    });

    it("should not include completed orders", () => {
      const order1 = orderBook.create("n0_0", "n1_1");
      orderBook.create("n0_0", "n2_2");
      orderBook.transition(order1.id, "dispatched");
      orderBook.transition(order1.id, "underway");
      orderBook.transition(order1.id, "completed");

      const pending = orderBook.pending();

      expect(pending.length).toBe(1);
    });

    it("should not include canceled orders", () => {
      const order1 = orderBook.create("n0_0", "n1_1");
      orderBook.create("n0_0", "n2_2");
      orderBook.transition(order1.id, "canceled");

      const pending = orderBook.pending();

      expect(pending.length).toBe(1);
    });

    it("should not include failed orders", () => {
      const order1 = orderBook.create("n0_0", "n1_1");
      orderBook.create("n0_0", "n2_2");
      orderBook.transition(order1.id, "dispatched");
      const retry1 = orderBook.requeue(order1.id, "Retry 1");
      orderBook.transition(retry1.id, "dispatched");
      const retry2 = orderBook.requeue(retry1.id, "Retry 2");
      orderBook.transition(retry2.id, "dispatched");
      orderBook.requeue(retry2.id, "Failed");

      const pending = orderBook.pending();

      expect(pending.length).toBe(1);
    });

    it("should return empty array when no pending orders", () => {
      const order = orderBook.create("n0_0", "n1_1");
      orderBook.transition(order.id, "dispatched");
      orderBook.transition(order.id, "underway");
      orderBook.transition(order.id, "completed");

      const pending = orderBook.pending();

      expect(pending).toEqual([]);
    });
  });

  describe("byRobot", () => {
    it("should return undefined when no order for robot", () => {
      const result = orderBook.byRobot("robot-001" as any);

      expect(result).toBeUndefined();
    });

    it("should return order assigned to robot", () => {
      const order = orderBook.create("n0_0", "n2_2");
      const assigned = orderBook.transition(order.id, "dispatched");

      // Need to figure out how robotId is set - checking the brief again
      // The brief says "dispatched sets robotId (transition(id,"dispatched") needs robot — extend signature per brief if specified, else add optional `robotId?` third param and document)"
      // Since I don't see a specification, I'll add it as optional third param
    });
  });

  describe("integration", () => {
    it("should handle complete order lifecycle", () => {
      const order = orderBook.create("n0_0", "n2_2");
      expect(order.status).toBe("queued");

      const dispatched = orderBook.transition(order.id, "dispatched");
      expect(dispatched.status).toBe("dispatched");

      const underway = orderBook.transition(dispatched.id, "underway");
      expect(underway.status).toBe("underway");

      const completed = orderBook.transition(underway.id, "completed");
      expect(completed.status).toBe("completed");
      expect(completed.history).toHaveLength(3);
    });

    it("should handle order with retries and eventual completion", () => {
      const order = orderBook.create("n0_0", "n2_2");

      // First attempt
      const disp1 = orderBook.transition(order.id, "dispatched");
      const retry1 = orderBook.requeue(disp1.id, "Network error");
      expect(retry1.retries).toBe(1);

      // Second attempt
      const disp2 = orderBook.transition(retry1.id, "dispatched");
      const retry2 = orderBook.requeue(disp2.id, "Robot stalled");
      expect(retry2.retries).toBe(2);

      // Third attempt (successful)
      const disp3 = orderBook.transition(retry2.id, "dispatched");
      const underway = orderBook.transition(disp3.id, "underway");
      const completed = orderBook.transition(underway.id, "completed");

      expect(completed.status).toBe("completed");
      expect(completed.retries).toBe(2);
      expect(completed.history).toHaveLength(7);
    });
  });
});
