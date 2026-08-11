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

  it("rolls back the whole migration on a mid-migration failure and does not record it as applied", async () => {
    const db = await createPgliteDriver();

    // Pre-create schema_migrations with an incompatible `id` column type (integer,
    // not text). migrate()'s own `create table if not exists schema_migrations`
    // silently skips on this name collision (Postgres's IF NOT EXISTS only checks
    // relation name, not column shape), so 001_init's real table/index creates all
    // still run inside the transaction — then the migration's own bookkeeping
    // insert (`values ('001_init', now())` into an integer id column) fails,
    // forcing a rollback of the whole single-call transaction, including the
    // table creates that already ran earlier in the same statement string.
    await db.query("create table schema_migrations (id integer primary key, applied_at timestamptz)");

    await expect(migrate(db)).rejects.toThrow();

    // pglite is a single persistent connection, so a failed multi-statement
    // transaction leaves the session in "aborted transaction" state until an
    // explicit rollback is sent — do that here to inspect post-failure state.
    // (A pooled pg driver doesn't need this from the caller: pg-pool's release()
    // destroys a client that errored instead of returning it to the pool, so the
    // next borrower always gets a clean connection.)
    await db.query("rollback");

    const rows = await db.query<{ id: string }>("select id from schema_migrations");
    expect(rows.rows).toHaveLength(0);

    // the 001_init table creates that ran before the failing insert must have
    // rolled back too — the transaction is all-or-nothing.
    await expect(db.query("select 1 from robots")).rejects.toThrow();

    await db.close();
  });
});
