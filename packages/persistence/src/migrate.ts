import type { SqlDriver } from "./driver.js";
import { MIGRATIONS } from "./migrations.js";

export async function migrate(driver: SqlDriver): Promise<string[]> {
  await driver.query(`
    create table if not exists schema_migrations (
      id text primary key,
      applied_at timestamptz
    );
  `);

  const applied = await driver.query<{ id: string }>("select id from schema_migrations");
  const appliedIds = new Set(applied.rows.map((row) => row.id));

  const newlyApplied: string[] = [];

  for (const migration of MIGRATIONS) {
    if (appliedIds.has(migration.id)) {
      continue;
    }

    await driver.query("begin");
    try {
      await driver.query(migration.sql);
      await driver.query("insert into schema_migrations (id, applied_at) values ($1, now())", [migration.id]);
      await driver.query("commit");
    } catch (err) {
      await driver.query("rollback");
      throw err;
    }

    newlyApplied.push(migration.id);
  }

  return newlyApplied;
}
