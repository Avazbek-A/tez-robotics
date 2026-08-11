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
  });
  it("GET /orders lists", async () => {
    const res = await app.inject({ method: "GET", url: "/orders" });
    expect(res.json().orders.length).toBeGreaterThan(0);
  });
  it("DELETE /orders/:id returns 501", async () => {
    const res = await app.inject({ method: "DELETE", url: "/orders/ord-00001" });
    expect(res.statusCode).toBe(501);
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
