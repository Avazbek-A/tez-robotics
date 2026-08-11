import { beforeAll, describe, it, expect } from "vitest";
import { createPgliteDriver } from "../src/pglite-driver.js";
import { migrate } from "../src/migrate.js";
import { createRepos } from "../src/repos.js";
import type { SqlDriver } from "../src/driver.js";
import type { Repos } from "../src/repos.js";
import type { TransportOrder, RobotId } from "@tez/core";
import type { RobotState } from "@tez/shared";

function asRobotId(id: string): RobotId {
  return id as RobotId;
}

describe("repos", () => {
  let driver: SqlDriver;
  let repos: Repos;

  beforeAll(async () => {
    driver = await createPgliteDriver();
    await migrate(driver);
    repos = createRepos(driver);
  });

  it("upserts an order and persists a status change on re-upsert", async () => {
    const order: TransportOrder = {
      id: "ord-00001",
      pickupNode: "A",
      dropNode: "B",
      status: "queued",
      retries: 0,
      createdAt: "2026-08-11T00:00:00.000Z",
      history: [],
    };
    await repos.orders.upsert(order);

    let rows = await repos.orders.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("queued");

    const updated: TransportOrder = { ...order, status: "dispatched", robotId: asRobotId("r1") };
    await repos.orders.upsert(updated);

    rows = await repos.orders.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("dispatched");
    expect(rows[0].robot_id).toBe("r1");
  });

  it("filters list by status and respects limit", async () => {
    const other: TransportOrder = {
      id: "ord-00002",
      pickupNode: "C",
      dropNode: "D",
      status: "queued",
      retries: 0,
      createdAt: "2026-08-11T00:01:00.000Z",
      history: [],
    };
    await repos.orders.upsert(other);

    const dispatched = await repos.orders.list({ status: "dispatched" });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].id).toBe("ord-00001");

    const limited = await repos.orders.list({ limit: 1 });
    expect(limited).toHaveLength(1);
  });

  it("appends history entries and fetches them ordered by at", async () => {
    await repos.orders.appendHistory("ord-00001", "2026-08-11T00:02:00.000Z", "dispatched", "r1", "assigned");
    await repos.orders.appendHistory("ord-00001", "2026-08-11T00:01:00.000Z", "queued", undefined, "created");

    const hist = await repos.orders.history("ord-00001");
    expect(hist).toHaveLength(2);
    expect(hist[0].status).toBe("queued");
    expect(hist[0].at).toBeDefined();
    expect(hist[1].status).toBe("dispatched");
    expect(hist[1].robot_id).toBe("r1");
  });

  it("breaks ties on equal `at` timestamps by insertion order (id asc)", async () => {
    const sameAt = "2026-08-11T00:03:00.000Z";
    await repos.orders.appendHistory("ord-00002", sameAt, "dispatched", "r2", "first");
    await repos.orders.appendHistory("ord-00002", sameAt, "underway", "r2", "second");

    const hist = await repos.orders.history("ord-00002");
    expect(hist).toHaveLength(2);
    expect(hist[0].status).toBe("dispatched");
    expect(hist[0].note).toBe("first");
    expect(hist[1].status).toBe("underway");
    expect(hist[1].note).toBe("second");
    expect(Number(hist[0].id)).toBeLessThan(Number(hist[1].id));
  });

  it("upserts a robot and lists it", async () => {
    const robot: RobotState = {
      id: "r1",
      pos: { x: 1, y: 2 },
      theta: 0,
      battery: 0.9,
      status: "IDLE",
      lastSeen: "2026-08-11T00:00:00.000Z",
    };
    await repos.robots.upsert(robot);

    let rows = await repos.robots.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("r1");
    // pglite accepts JS objects directly as jsonb params (verified against
    // stringified equivalent) — see repos.ts for the comment on this choice.
    expect(rows[0].last_state).toMatchObject({ id: "r1", battery: 0.9 });

    const updatedRobot: RobotState = { ...robot, battery: 0.5, status: "CHARGING" };
    await repos.robots.upsert(updatedRobot);

    rows = await repos.robots.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].last_state).toMatchObject({ battery: 0.5, status: "CHARGING" });
  });

  it("inserts kpi snapshots and queries by range", async () => {
    await repos.snapshots.insertKpi("2026-08-11T01:00:00.000Z", {
      ordersPerHour: 12,
      avgCycleMs: 3400,
      utilization: 0.7,
    });
    await repos.snapshots.insertKpi("2026-08-11T03:00:00.000Z", {
      ordersPerHour: 8,
      avgCycleMs: 4100,
      utilization: 0.4,
    });

    const rows = await repos.snapshots.kpiRange("2026-08-11T00:00:00.000Z", "2026-08-11T02:00:00.000Z");
    expect(rows).toHaveLength(1);
    expect(rows[0].orders_per_hour).toBe(12);
  });

  it("inserts state snapshots and prunes only rows older than the cutoff", async () => {
    await repos.snapshots.insertState("2026-08-11T00:00:00.000Z", { robots: [] });
    await repos.snapshots.insertState("2026-08-11T05:00:00.000Z", { robots: [{ id: "r1" }] });

    const deleted = await repos.snapshots.pruneStateOlderThan("2026-08-11T02:00:00.000Z");
    expect(deleted).toBe(1);

    const remaining = await driver.query("select * from state_snapshots");
    expect(remaining.rows).toHaveLength(1);
  });
});
