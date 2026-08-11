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

    // begin/migration sql/record/commit are sent as ONE multi-statement call
    // (params: undefined) so the whole migration rides a single connection —
    // splitting this across multiple driver.query() calls is unsafe under a
    // pooled driver (pg.Pool), since each call may be handed a different
    // pooled connection, breaking the transaction or leaking an open one
    // back into the pool. migration.id is an internal literal constant from
    // MIGRATIONS (not user input), so inlining it into the SQL text below is
    // safe.
    const sql = `
      begin;
      ${migration.sql}
      insert into schema_migrations (id, applied_at) values ('${migration.id}', now());
      commit;
    `;
    await driver.query(sql);

    newlyApplied.push(migration.id);
  }

  return newlyApplied;
}
