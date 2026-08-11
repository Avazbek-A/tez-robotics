import { describe, it, expect } from "vitest";
import { createPgliteDriver } from "../src/pglite-driver.js";
import { migrate } from "../src/migrate.js";

describe("migrate on pglite", () => {
  it("applies all migrations once, idempotent", async () => {
    const db = await createPgliteDriver();
    const first = await migrate(db);
    expect(first).toContain("001_init");
    const second = await migrate(db);
    expect(second).toHaveLength(0);
    const r = await db.query("insert into kpi_snapshots(at, orders_per_hour, avg_cycle_ms, utilization) values (now(), 1, 2, 0.5) returning id");
    expect(r.rows[0].id).toBeDefined();
    await db.close();
  });
});
