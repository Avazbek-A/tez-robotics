import type { Repos } from "@tez/persistence";
import type { System } from "./system.js";

export interface RecorderOpts {
  /** Cadence, in ms, for full-state + kpi snapshots (snapshots.insertState/insertKpi). Default 5000. */
  snapshotEveryMs?: number;
}

export interface Recorder {
  stop(): void;
}

/**
 * Fixed poll cadence for order-status diffing and robot upserts — separate
 * from `snapshotEveryMs`, which only throttles the (heavier) full-state/kpi
 * snapshot writes. Not configurable: recorder responsiveness to order status
 * changes shouldn't depend on the snapshot-retention cadence.
 */
const POLL_MS = 1000;

function warn(context: string, err: unknown): void {
  console.warn(`recorder: ${context} failed`, err);
}

/**
 * Polls `system.orchestrator.snapshot()` on a fixed 1s cadence and mirrors
 * it into `repos`:
 *  - orders whose status changed since the last poll (tracked via a local
 *    `Map<orderId, status>`) are upserted and get a history row appended.
 *  - robots are upserted every poll (cheap, no diffing needed).
 *  - every `snapshotEveryMs`, a full state + kpi snapshot is recorded.
 *
 * Runs one poll synchronously before returning so short-lived callers (and
 * tests) observe the state at start() time rather than waiting a full
 * POLL_MS for the first write. All repo writes are fire-and-forget —
 * `.catch(...)`'d individually so persistence failures never throw into the
 * poll loop or block request handling.
 */
export function startRecorder(system: System, repos: Repos, opts?: RecorderOpts): Recorder {
  const snapshotEveryMs = opts?.snapshotEveryMs ?? 5000;
  const lastStatus = new Map<string, string>();
  let lastSnapshotAt = 0;

  function poll(): void {
    const snap = system.orchestrator.snapshot();
    const nowIso = new Date().toISOString();

    for (const order of snap.orders) {
      if (lastStatus.get(order.id) === order.status) continue;
      lastStatus.set(order.id, order.status);
      repos.orders.upsert(order).catch((err) => warn("orders.upsert", err));
      repos.orders
        .appendHistory(order.id, nowIso, order.status, order.robotId)
        .catch((err) => warn("orders.appendHistory", err));
    }

    for (const robot of snap.robots) {
      repos.robots.upsert(robot).catch((err) => warn("robots.upsert", err));
    }

    const nowMs = Date.now();
    if (nowMs - lastSnapshotAt >= snapshotEveryMs) {
      lastSnapshotAt = nowMs;
      repos.snapshots.insertState(nowIso, snap).catch((err) => warn("snapshots.insertState", err));
      repos.snapshots.insertKpi(nowIso, snap.kpis).catch((err) => warn("snapshots.insertKpi", err));
    }
  }

  poll();
  const timer = setInterval(poll, POLL_MS);

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
