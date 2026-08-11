import { PGlite } from "@electric-sql/pglite";
import type { SqlDriver } from "./driver.js";

export async function createPgliteDriver(dataDir?: string): Promise<SqlDriver> {
  const db = dataDir === undefined || dataDir === "memory" ? new PGlite() : new PGlite(dataDir);
  await db.waitReady;

  return {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      // Invariant: pass params only for single-statement SQL; undefined params → exec() multi-statement path.
      if (params === undefined) {
        // db.query() uses the extended (prepared-statement) protocol, which
        // rejects SQL text containing more than one statement. Migration SQL
        // and other unparameterized calls may contain multiple statements,
        // so route those through db.exec(), which uses the simple protocol.
        const results = await db.exec(sql);
        const last = results[results.length - 1];
        return { rows: (last?.rows ?? []) as T[] };
      }
      const result = await db.query<T>(sql, params);
      return { rows: result.rows };
    },
    async close() {
      await db.close();
    },
  };
}
