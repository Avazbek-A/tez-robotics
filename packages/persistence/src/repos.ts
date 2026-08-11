import type { SqlDriver } from "./driver.js";
import type { TransportOrder } from "@tez/core";
import type { RobotState } from "@tez/shared";

export interface Repos {
  orders: {
    upsert(o: TransportOrder): Promise<void>;
    appendHistory(orderId: string, at: string, status: string, robotId?: string, note?: string): Promise<void>;
    list(opts?: { status?: string; limit?: number }): Promise<Array<Record<string, unknown>>>;
    history(orderId: string): Promise<Array<Record<string, unknown>>>;
  };
  robots: {
    upsert(r: RobotState): Promise<void>;
    list(): Promise<Array<Record<string, unknown>>>;
  };
  snapshots: {
    insertState(at: string, snapshot: unknown): Promise<void>;
    insertKpi(at: string, k: { ordersPerHour: number; avgCycleMs: number; utilization: number }): Promise<void>;
    kpiRange(fromIso: string, toIso: string): Promise<Array<Record<string, unknown>>>;
    pruneStateOlderThan(iso: string): Promise<number>;
  };
}

export function createRepos(driver: SqlDriver): Repos {
  return {
    orders: {
      async upsert(o: TransportOrder): Promise<void> {
        await driver.query(
          `insert into transport_orders (id, pickup_node, drop_node, status, robot_id, retries, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, now())
           on conflict (id) do update set
             pickup_node = excluded.pickup_node,
             drop_node = excluded.drop_node,
             status = excluded.status,
             robot_id = excluded.robot_id,
             retries = excluded.retries,
             updated_at = now()`,
          [o.id, o.pickupNode, o.dropNode, o.status, o.robotId ?? null, o.retries, o.createdAt]
        );
      },

      async appendHistory(
        orderId: string,
        at: string,
        status: string,
        robotId?: string,
        note?: string
      ): Promise<void> {
        await driver.query(
          `insert into transport_order_history (order_id, at, status, robot_id, note)
           values ($1, $2, $3, $4, $5)`,
          [orderId, at, status, robotId ?? null, note ?? null]
        );
      },

      async list(opts?: { status?: string; limit?: number }): Promise<Array<Record<string, unknown>>> {
        const params: unknown[] = [];
        let sql = "select * from transport_orders";
        if (opts?.status !== undefined) {
          params.push(opts.status);
          sql += ` where status = $${params.length}`;
        }
        sql += " order by created_at desc";
        if (opts?.limit !== undefined) {
          params.push(opts.limit);
          sql += ` limit $${params.length}`;
        }
        const r = await driver.query(sql, params);
        return r.rows;
      },

      async history(orderId: string): Promise<Array<Record<string, unknown>>> {
        const r = await driver.query(
          "select * from transport_order_history where order_id = $1 order by at asc",
          [orderId]
        );
        return r.rows;
      },
    },

    robots: {
      async upsert(r: RobotState): Promise<void> {
        // JSONB param note (verified against pglite): pglite's parameterized
        // query() accepts a plain JS object directly for a jsonb column — no
        // JSON.stringify(...) needed. Passing the whole RobotState as
        // last_state here.
        await driver.query(
          `insert into robots (id, last_state, updated_at)
           values ($1, $2, now())
           on conflict (id) do update set
             last_state = excluded.last_state,
             updated_at = now()`,
          [r.id, r]
        );
      },

      async list(): Promise<Array<Record<string, unknown>>> {
        const r = await driver.query("select * from robots order by id");
        return r.rows;
      },
    },

    snapshots: {
      async insertState(at: string, snapshot: unknown): Promise<void> {
        await driver.query("insert into state_snapshots (at, snapshot) values ($1, $2)", [at, snapshot]);
      },

      async insertKpi(
        at: string,
        k: { ordersPerHour: number; avgCycleMs: number; utilization: number }
      ): Promise<void> {
        await driver.query(
          `insert into kpi_snapshots (at, orders_per_hour, avg_cycle_ms, utilization)
           values ($1, $2, $3, $4)`,
          [at, k.ordersPerHour, k.avgCycleMs, k.utilization]
        );
      },

      async kpiRange(fromIso: string, toIso: string): Promise<Array<Record<string, unknown>>> {
        const r = await driver.query(
          "select * from kpi_snapshots where at >= $1 and at <= $2 order by at asc",
          [fromIso, toIso]
        );
        return r.rows;
      },

      async pruneStateOlderThan(iso: string): Promise<number> {
        const r = await driver.query("delete from state_snapshots where at < $1 returning id", [iso]);
        return r.rows.length;
      },
    },
  };
}
