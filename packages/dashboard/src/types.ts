import type { RobotState } from "@tez/shared";
import type { TransportOrder } from "@tez/core";

// Re-exported so the rest of the dashboard can import robot/order shapes
// from a single local module instead of reaching into two workspace
// packages directly.
export type { RobotState, TransportOrder };

/**
 * Field-for-field duplicate of the server's `StateFrame`
 * (packages/api/src/ws.ts) sent over `/ws/state`. The dashboard does not
 * import server code, so this interface is kept in sync by hand.
 *
 * `RobotState` and `TransportOrder` are the two exceptions: they are
 * imported from `@tez/shared` / `@tez/core`, which are already types-only
 * workspace deps of this package, rather than redefined here — those two
 * shapes are large and change with orchestrator logic, so importing them
 * avoids drift. The frame envelope itself (t/seq/degraded/kpis/alarms) is
 * small and stable, so it is duplicated verbatim per the task brief.
 */
export interface StateFrame {
  t: string; // ISO timestamp
  seq: number; // per-connection increasing; NOT contiguous across reconnects
  // (late joiners share the server's global counter, so a second frame can
  // jump far ahead of the first frame's seq=0)
  degraded: boolean;
  robots: RobotState[];
  orders: TransportOrder[];
  kpis: {
    ordersPerHour: number;
    avgCycleMs: number;
    utilization: number;
  };
  alarms: string[];
}
