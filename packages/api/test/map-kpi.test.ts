import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WarehouseMap } from "@tez/core";
import { buildSystem } from "../src/system.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let stop: () => Promise<void>;
let mapFile: string;
let bootMapJson: unknown;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "tez-api-map-"));
  mapFile = join(dir, "map.json");
  bootMapJson = WarehouseMap.grid(4, 4);
  writeFileSync(mapFile, JSON.stringify(bootMapJson));

  const config = loadConfig({
    DEMO: "1",
    TICK_MS: "10",
    ROBOTS: "1",
    MAP_FILE: mapFile,
  });
  const sys = await buildSystem(config);
  await sys.start();
  stop = () => sys.stop();
  app = await buildServer(sys, { config });
});

afterAll(async () => {
  await app.close();
  await stop();
});

describe("map + kpi", () => {
  it("GET /map returns the shape the system booted with", async () => {
    const res = await app.inject({ method: "GET", url: "/map" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(bootMapJson);
  });

  it("PUT /map rejects an invalid map body with 400 {error}", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/map",
      payload: { nodes: [], edges: [{ from: "missing", to: "also-missing" }] },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(typeof body.error).toBe("string");
  });

  it("PUT /map with a valid body writes to config.mapFile and returns restartRequired", async () => {
    const newMap = WarehouseMap.grid(2, 2);
    const res = await app.inject({ method: "PUT", url: "/map", payload: newMap });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, restartRequired: true });

    const written = JSON.parse(readFileSync(mapFile, "utf-8"));
    expect(written).toEqual(newMap);
  });

  it("GET /kpi returns live snapshot kpis including utilization", async () => {
    const res = await app.inject({ method: "GET", url: "/kpi" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.live).toHaveProperty("utilization");
    expect(body.live).toHaveProperty("ordersPerHour");
    expect(body.live).toHaveProperty("avgCycleMs");
    expect(typeof body.live.utilization).toBe("number");
  });

  it("GET /docs/json serves the OpenAPI document", async () => {
    const res = await app.inject({ method: "GET", url: "/docs/json" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.openapi).toMatch(/^3\./);
  });
});
