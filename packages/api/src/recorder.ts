import type { Repos } from "@tez/persistence";
import type { System } from "./system.js";

export interface RecorderOpts {
  /** Cadence, in ms, for full-state + kpi snapshots (snapshots.insertState/insertKpi). Default 5000. */
  snapshotEveryMs?: number;
  /** Cadence, in ms, for pruning old state_snapshots rows. Default PRUNE_EVERY_MS. */
  pruneEveryMs?: number;
  /** How far back (in ms) state_snapshots rows are retained before pruning. Default RETENTION_MS. */
  retentionMs?: number;
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

/** Default cadence, in ms, for pruning state_snapshots rows older than RETENTION_MS. */
const PRUNE_EVERY_MS = 10 * 60 * 1000;

/** Default retention window, in ms, for state_snapshots rows before they're pruned. */
const RETENTION_MS = 24 * 3600 * 1000;

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
 * Separately, every `pruneEveryMs` (default `PRUNE_EVERY_MS`, 10 minutes),
 * `repos.snapshots.pruneStateOlderThan` deletes `state_snapshots` rows older
 * than `retentionMs` (default `RETENTION_MS`, 24h) — otherwise the table
 * grows unbounded at the `snapshotEveryMs` insert cadence. `kpi_snapshots`
 * is left alone (Analytics tab reads a rolling window of it; it's much
 * smaller per-row than the full-state JSONB blob).
 *
 * Runs one poll and one prune synchronously before returning so short-lived
 * callers (and tests) observe the state at start() time rather than waiting
 * a full POLL_MS/pruneEveryMs for the first write. All repo writes are
 * fire-and-forget — `.catch(...)`'d individually so persistence failures
 * never throw into the poll loop or block request handling.
 */
export function startRecorder(system: System, repos: Repos, opts?: RecorderOpts): Recorder {
  const snapshotEveryMs = opts?.snapshotEveryMs ?? 5000;
  const pruneEveryMs = opts?.pruneEveryMs ?? PRUNE_EVERY_MS;
  const retentionMs = opts?.retentionMs ?? RETENTION_MS;
  const lastStatus = new Map<string, string>();
  let lastSnapshotAt = 0;

  function prune(): void {
    const cutoff = new Date(Date.now() - retentionMs).toISOString();
    repos.snapshots.pruneStateOlderThan(cutoff).catch((err) => warn("snapshots.pruneStateOlderThan", err));
  }

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

  prune();
  const pruneTimer = setInterval(prune, pruneEveryMs);

  return {
    stop(): void {
      clearInterval(timer);
      clearInterval(pruneTimer);
    },
  };
}
