import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { createPgliteDriver, migrate, createRepos, type Repos, type SqlDriver } from "@tez/persistence";
import { buildSystem, type System } from "../src/system.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { startRecorder } from "../src/recorder.js";

describe("persistence wiring", () => {
  let sys: System;
  let driver: SqlDriver;
  let repos: Repos;
  let app: FastifyInstance;
  let recorder: { stop(): void };
  let orderId: string;
  let fromIso: string;
  let toIso: string;

  beforeAll(async () => {
    sys = await buildSystem(loadConfig({ DEMO: "1", TICK_MS: "10" }));
    await sys.start();

    driver = await createPgliteDriver();
    await migrate(driver);
    repos = createRepos(driver);

    fromIso = new Date(Date.now() - 5_000).toISOString();

    // submitOrder() then startRecorder() back-to-back, synchronously, so the
    // recorder's immediate first poll (see recorder.ts) is guaranteed to
    // observe the order still "queued" — no tick can run between these two
    // calls since the demo lockstep interval only fires on its own timer,
    // never mid-synchronous-execution.
    const order = sys.orchestrator.submitOrder("n2_2", "n5_5");
    orderId = order.id;
    recorder = startRecorder(sys, repos, { snapshotEveryMs: 50 });

    // ~1.5s lockstep: with TICK_MS=10 the order completes well under 1s, and
    // the recorder's fixed 1s poll interval fires once more in this window —
    // long enough to observe (and record) the queued -> ... -> completed
    // transition, and to accumulate several kpi/state snapshots at the 50ms
    // test cadence.
    await new Promise((r) => setTimeout(r, 1500));
    toIso = new Date().toISOString();

    app = await buildServer(sys, { repos });
  });

  afterAll(async () => {
    recorder.stop();
    await app.close();
    await sys.stop();
    await driver.close();
  });

  it("records order history to the DB across the queued -> completed lifecycle", async () => {
    const rows = await repos.orders.history(orderId);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const statuses = rows.map((r) => r.status);
    expect(statuses).toContain("queued");
    expect(statuses).toContain("completed");
  });

  it("records kpi/state snapshots", async () => {
    const kpiRows = await repos.snapshots.kpiRange(fromIso, toIso);
    expect(kpiRows.length).toBeGreaterThan(0);
  });

  it("GET /orders?history=1 attaches DB history per order (repos present)", async () => {
    const res = await app.inject({ method: "GET", url: "/orders?history=1" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const order = body.orders.find((o: { id: string }) => o.id === orderId);
    expect(order).toBeDefined();
    expect(Array.isArray(order.history)).toBe(true);
    expect(order.history.length).toBeGreaterThanOrEqual(2);
    // DB-shaped rows carry `status` (not the in-memory {from,to} shape).
    expect(order.history[0]).toHaveProperty("status");
  });

  it("GET /kpi?from=&to= returns a non-null range when repos are present", async () => {
    const res = await app.inject({ method: "GET", url: `/kpi?from=${fromIso}&to=${toIso}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.live).toHaveProperty("utilization");
    expect(Array.isArray(body.range)).toBe(true);
    expect(body.range.length).toBeGreaterThan(0);
  });
});

describe("GET /kpi?from= without repos", () => {
  it("returns range: null and a persistence-disabled note", async () => {
    const sys2 = await buildSystem(loadConfig({ DEMO: "1", TICK_MS: "10" }));
    await sys2.start();
    const app2 = await buildServer(sys2);
    try {
      const res = await app2.inject({ method: "GET", url: "/kpi?from=2026-01-01T00:00:00.000Z" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.range).toBeNull();
      expect(body.note).toBe("persistence disabled");
    } finally {
      await app2.close();
      await sys2.stop();
    }
  });
});

describe("recorder: snapshot retention pruning", () => {
  it("prunes state_snapshots rows older than the retention window; fresh rows remain", async () => {
    const sys4 = await buildSystem(loadConfig({ DEMO: "1", TICK_MS: "10" }));
    await sys4.start();

    const driver4 = await createPgliteDriver();
    await migrate(driver4);
    const repos4 = createRepos(driver4);

    const RETENTION_MS = 24 * 3600 * 1000;
    const oldIso = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
    await repos4.snapshots.insertState(oldIso, {
      robots: [],
      orders: [],
      kpis: { ordersPerHour: 0, avgCycleMs: 0, utilization: 0 },
    });

    // Sanity: the pre-seeded old row is actually there before the recorder
    // (and its prune loop) starts.
    const before = await driver4.query("select count(*)::int as n from state_snapshots", []);
    expect((before.rows[0] as { n: number }).n).toBe(1);

    // Tiny pruneEveryMs/snapshotEveryMs so both the recorder's synchronous
    // first prune (on start, see recorder.ts) and its first fresh
    // snapshot write land within this test's wait window.
    const recorder4 = startRecorder(sys4, repos4, {
      snapshotEveryMs: 50,
      pruneEveryMs: 50,
      retentionMs: RETENTION_MS,
    });

    await new Promise((r) => setTimeout(r, 300));

    const after = await driver4.query("select at from state_snapshots order by at asc", []);
    // Fresh rows from the recorder's own poll() writes are present...
    expect(after.rows.length).toBeGreaterThan(0);
    // ...and none of them is the stale, pre-seeded 2-day-old row (or any
    // other row older than the retention window).
    const cutoff = Date.now() - RETENTION_MS;
    for (const row of after.rows) {
      expect(new Date((row as { at: string }).at).getTime()).toBeGreaterThan(cutoff);
    }

    recorder4.stop();
    await sys4.stop();
    await driver4.close();
  });
});

describe("api works fully with NO repos", () => {
  it("GET /health still returns 200 and GET /orders?history=1 still works (in-memory history)", async () => {
    const sys3 = await buildSystem(loadConfig({ DEMO: "1", TICK_MS: "10" }));
    await sys3.start();
    const app3 = await buildServer(sys3);
    try {
      const health = await app3.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json().status).toBe("ok");

      const order = sys3.orchestrator.submitOrder("n2_2", "n5_5");
      const res = await app3.inject({ method: "GET", url: "/orders?history=1" });
      expect(res.statusCode).toBe(200);
      const found = res.json().orders.find((o: { id: string }) => o.id === order.id);
      expect(found).toBeDefined();
      expect(Array.isArray(found.history)).toBe(true);
    } finally {
      await app3.close();
      await sys3.stop();
    }
  });
});
