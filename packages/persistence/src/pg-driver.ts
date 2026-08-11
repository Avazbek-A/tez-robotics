import pg from "pg";
import type { SqlDriver } from "./driver.js";

export function createPgDriver(databaseUrl: string): SqlDriver {
  const pool = new pg.Pool({ connectionString: databaseUrl });

  return {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      // pool.query's generic overloads require T extends QueryResultRow, which SqlDriver's
      // unconstrained T can't satisfy — call untyped and cast the result to the caller's T instead.
      const result = await pool.query(sql, params as unknown[] | undefined);
      return { rows: result.rows as T[] };
    },
    async close() {
      await pool.end();
    },
  };
}
