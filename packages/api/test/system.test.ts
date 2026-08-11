import { describe, it, expect } from "vitest";
import { buildSystem } from "../src/system.js";
import { loadConfig } from "../src/config.js";

describe("buildSystem demo mode", () => {
  it("boots FakeAdapter fleet and completes an order via lockstep interval", async () => {
    const sys = await buildSystem(loadConfig({ DEMO: "1", TICK_MS: "10" }));
    await sys.start();
    try {
      const order = sys.orchestrator.submitOrder("n2_2", "n5_5");
      expect(order.status).toBe("queued");
      await new Promise((r) => setTimeout(r, 1500));
      const snap = sys.orchestrator.snapshot();
      const done = snap.orders.find((o) => o.id === order.id);
      expect(done?.status).toBe("completed");
      expect(snap.robots).toHaveLength(3);
    } finally {
      await sys.stop();
    }
  });
});
