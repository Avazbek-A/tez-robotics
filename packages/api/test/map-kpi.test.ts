import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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
let tmpDir: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "tez-api-map-"));
  mapFile = join(tmpDir, "map.json");
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
  rmSync(tmpDir, { recursive: true, force: true });
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

  it("GET /kpi?from= with a malformed timestamp returns 400 {error} instead of a raw pg error", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/kpi?from=2026-08-11T06:30:20.817943 00:00",
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body).toEqual({ error: "invalid from/to timestamp" });
  });

  it("GET /kpi?from=<valid>&to=<malformed> also returns 400 {error} (to is validated too)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/kpi?from=2026-01-01T00:00:00.000Z&to=not-a-date",
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body).toEqual({ error: "invalid from/to timestamp" });
  });

  it("GET /docs/json serves the OpenAPI document", async () => {
    const res = await app.inject({ method: "GET", url: "/docs/json" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.openapi).toMatch(/^3\./);
  });
});

describe("PUT /map write failure", () => {
  it("responds 500 {error} when the write target's directory doesn't exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tez-api-map-fail-"));
    const bootFile = join(dir, "boot.json");
    writeFileSync(bootFile, JSON.stringify(WarehouseMap.grid(2, 2)));
    // Parent directory intentionally absent so fs/promises.writeFile fails
    // with ENOENT — exercises the route's write-failure catch branch.
    const unwritableTarget = join(dir, "no-such-subdir", "map.json");

    const config = loadConfig({
      DEMO: "1",
      TICK_MS: "10",
      ROBOTS: "1",
      MAP_FILE: bootFile,
    });
    const sys = await buildSystem(config);
    await sys.start();
    const failApp = await buildServer(sys, { config: { ...config, mapFile: unwritableTarget } });

    try {
      const res = await failApp.inject({
        method: "PUT",
        url: "/map",
        payload: WarehouseMap.grid(2, 2),
      });
      expect(res.statusCode).toBe(500);
      const body = res.json();
      expect(typeof body.error).toBe("string");
      expect(Object.keys(body)).toEqual(["error"]);
    } finally {
      await failApp.close();
      await sys.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
