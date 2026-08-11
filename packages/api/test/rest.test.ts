import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildSystem } from "../src/system.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let stop: () => Promise<void>;
beforeAll(async () => {
  const sys = await buildSystem(loadConfig({ DEMO: "1", TICK_MS: "10" }));
  await sys.start();
  stop = () => sys.stop();
  app = await buildServer(sys);
});
afterAll(async () => { await app.close(); await stop(); });

describe("REST", () => {
  it("POST /orders creates queued order", async () => {
    const res = await app.inject({ method: "POST", url: "/orders",
      payload: { pickupNode: "n2_2", dropNode: "n5_5" } });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("queued");
  });
  it("POST /orders rejects unknown node", async () => {
    const res = await app.inject({ method: "POST", url: "/orders",
      payload: { pickupNode: "nope", dropNode: "n5_5" } });
    expect(res.statusCode).toBe(400);
  });
  it("POST /orders rejects missing body field", async () => {
    const res = await app.inject({ method: "POST", url: "/orders", payload: { pickupNode: "n2_2" } });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(typeof body.error).toBe("string");
    expect(body).not.toHaveProperty("statusCode");
    expect(Object.keys(body)).toEqual(["error"]);
  });
  it("GET /orders lists", async () => {
    const res = await app.inject({ method: "GET", url: "/orders" });
    expect(res.json().orders.length).toBeGreaterThan(0);
  });
  it("DELETE /orders/:id cancels a non-terminal order", async () => {
    const create = await app.inject({ method: "POST", url: "/orders",
      payload: { pickupNode: "n1_1", dropNode: "n6_6" } });
    const order = create.json();
    const res = await app.inject({ method: "DELETE", url: `/orders/${order.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("canceled");
    expect(res.json().id).toBe(order.id);
  });
  it("DELETE /orders/:id 404s on unknown id", async () => {
    const res = await app.inject({ method: "DELETE", url: "/orders/nope-does-not-exist" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/order not found/);
  });
  it("DELETE /orders/:id 409s on an already-terminal order", async () => {
    const create = await app.inject({ method: "POST", url: "/orders",
      payload: { pickupNode: "n2_2", dropNode: "n5_5" } });
    const order = create.json();
    const deadline = Date.now() + 3000;
    let status: string | undefined = order.status;
    while (status !== "completed" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      const list = await app.inject({ method: "GET", url: "/orders" });
      status = list.json().orders.find((o: { id: string }) => o.id === order.id)?.status;
    }
    expect(status).toBe("completed");
    const res = await app.inject({ method: "DELETE", url: `/orders/${order.id}` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/order already terminal/);
  });
  it("GET /robots returns fleet", async () => {
    const res = await app.inject({ method: "GET", url: "/robots" });
    expect(res.json().robots).toHaveLength(3);
  });
  it("GET /health ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.json().status).toBe("ok");
  });
});
