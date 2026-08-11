import { useState } from "react";
import type { TransportOrder } from "../types";
import { useI18n } from "../i18n";
import { ORDER_STATUS_COLORS } from "../status-colors";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

const STATUS_LABEL_KEY: Record<TransportOrder["status"], string> = {
  queued: "orderQueued",
  dispatched: "orderDispatched",
  underway: "orderUnderway",
  completed: "orderCompleted",
  failed: "orderFailed",
  canceled: "orderCanceled",
};

/** queued sorts first, then dispatched/underway, then the terminal statuses. */
const STATUS_SORT_RANK: Record<TransportOrder["status"], number> = {
  queued: 0,
  dispatched: 1,
  underway: 2,
  completed: 3,
  failed: 4,
  canceled: 5,
};

/**
 * Curated pickup/drop pairs for the "+ order" dev-nicety button. Valid node
 * ids on the demo 8x8 grid (`WarehouseMap.grid(8, 8)`, see
 * packages/api/src/demo-map.ts) are `n{x}_{y}` for x,y in 0..7 — hardcoded
 * here (rather than fetched from GET /map) to keep this component
 * dependency-free and synchronously testable; documented in task-12-report.
 * `scripts/demo.mjs` seeds orders from an equivalent curated list
 * independently (plain JS, can't import this TS module).
 */
const CURATED_PAIRS: readonly [string, string][] = [
  ["n1_1", "n6_1"],
  ["n1_6", "n6_6"],
  ["n2_2", "n5_5"],
  ["n3_1", "n1_3"],
  ["n6_3", "n3_6"],
  ["n1_1", "n6_6"],
  ["n4_1", "n1_4"],
  ["n6_2", "n2_6"],
];

function randomPair(): [string, string] {
  return CURATED_PAIRS[Math.floor(Math.random() * CURATED_PAIRS.length)];
}

export interface TaskQueueProps {
  orders: TransportOrder[];
}

/** Bottom-strip order queue: compact rows + a demo "+ order" button (also used on camera). */
export function TaskQueue({ orders }: TaskQueueProps) {
  // See App.tsx's ConnectionChip: `t` alone is a stable closure reference
  // that never changes identity on lang switch, so a `t`-only selector never
  // re-renders this component when lang changes. Also selecting `lang`
  // forces the re-render; `t` then reads the fresh lang when called during
  // that render.
  const lang = useI18n((s) => s.lang);
  const t = useI18n((s) => s.t);
  void lang; // subscription-only: forces re-render, not read directly
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sorted = [...orders].sort(
    (a, b) => STATUS_SORT_RANK[a.status] - STATUS_SORT_RANK[b.status],
  );

  async function addOrder(): Promise<void> {
    const [pickupNode, dropNode] = randomPair();
    setPosting(true);
    setError(null);
    try {
      const res = await fetch("/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pickupNode, dropNode }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `POST /orders failed: ${res.status}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--text)]/60">
          {t("taskQueueTitle")}
        </h2>
        <Button onClick={addOrder} disabled={posting}>
          {t("addOrder")}
        </Button>
      </div>

      {error && <div className="text-xs text-[#ef4444]">{error}</div>}

      {/* min-h-0 is load-bearing: without it a flex/grid child with flex-1
          keeps its content-driven min-height (the "auto" default), so it
          never actually shrinks to the bottom strip's fixed height — the
          ancestor's overflow-hidden then hard-clips the last row instead
          of this element scrolling. pb-2 keeps the final row's bottom
          border clear of the strip edge once scrolling does kick in. */}
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pb-2">
        {sorted.length === 0 && (
          <div className="py-2 text-xs text-[var(--text)]/50">{t("noOrders")}</div>
        )}
        {sorted.map((order) => (
          <div
            key={order.id}
            data-testid={`order-row-${order.id}`}
            className="flex items-center justify-between gap-2 rounded-md bg-white/[0.03] px-2 py-1 text-xs"
          >
            <span className="font-mono-num truncate text-[var(--text)]/80">{order.id}</span>
            <span className="font-mono-num truncate text-[var(--text)]/50">
              {order.pickupNode} → {order.dropNode}
            </span>
            {order.robotId && (
              <span className="font-mono-num truncate text-[var(--text)]/50">{order.robotId}</span>
            )}
            <Badge color={ORDER_STATUS_COLORS[order.status]}>{t(STATUS_LABEL_KEY[order.status])}</Badge>
          </div>
        ))}
      </div>
    </div>
  );
}
