import { useMemo, useState } from "react";
import { useI18n } from "../i18n";
import { useFleetStore } from "../store";
import { ORDER_STATUS_COLORS } from "../status-colors";
import { Badge } from "../components/ui/badge";
import type { TransportOrder } from "../types";

const STATUS_LABEL_KEY: Record<TransportOrder["status"], string> = {
  queued: "orderQueued",
  dispatched: "orderDispatched",
  underway: "orderUnderway",
  completed: "orderCompleted",
  failed: "orderFailed",
  canceled: "orderCanceled",
};

const ALL_STATUSES: TransportOrder["status"][] = [
  "queued",
  "dispatched",
  "underway",
  "completed",
  "failed",
  "canceled",
];

/** In-memory `TransportOrder.history` entry shape (@tez/core's OrderBook, no DB). */
interface InMemoryHistoryEntry {
  at: string;
  from: TransportOrder["status"];
  to: TransportOrder["status"];
  reason?: string;
}

/**
 * `transport_order_history` DB row shape, as returned by GET
 * /orders?history=1 when persistence is on (see
 * packages/api/src/routes/orders.ts's DbHistoryEntrySchema). `id` is a
 * bigserial — pglite returns `number`, node-postgres returns `string`.
 */
interface DbHistoryEntry {
  id: string | number;
  order_id: string;
  at: string;
  status: TransportOrder["status"];
  robot_id: string | null;
  note: string | null;
}

type OrderHistoryEntry = InMemoryHistoryEntry | DbHistoryEntry;

function isDbHistoryEntry(entry: OrderHistoryEntry): entry is DbHistoryEntry {
  return "order_id" in entry;
}

interface OrdersHistoryResponse {
  orders: (Omit<TransportOrder, "history"> & { history: OrderHistoryEntry[] })[];
}

function HistoryTimeline({
  entries,
  loading,
}: {
  entries: OrderHistoryEntry[] | undefined;
  loading: boolean;
}) {
  const t = useI18n((s) => s.t);

  if (loading) {
    return <p className="py-2 text-xs text-[var(--text)]/50">{t("historyLoading")}</p>;
  }
  if (!entries || entries.length === 0) {
    return <p className="py-2 text-xs text-[var(--text)]/50">{t("noHistory")}</p>;
  }

  return (
    <ul className="space-y-1 py-2">
      {entries.map((entry, i) => (
        <li
          key={isDbHistoryEntry(entry) ? entry.id : `${entry.at}-${i}`}
          className="flex flex-wrap items-center gap-2 text-xs text-[var(--text)]/70"
        >
          <span className="font-mono-num text-[var(--text)]/50">
            {new Date(entry.at).toLocaleString()}
          </span>
          {isDbHistoryEntry(entry) ? (
            <>
              <Badge color={ORDER_STATUS_COLORS[entry.status]}>{t(STATUS_LABEL_KEY[entry.status])}</Badge>
              {entry.robot_id && <span className="font-mono-num">{entry.robot_id}</span>}
              {entry.note && <span>{entry.note}</span>}
            </>
          ) : (
            <>
              <span>
                {t(STATUS_LABEL_KEY[entry.from])} → {t(STATUS_LABEL_KEY[entry.to])}
              </span>
              {entry.reason && <span>{entry.reason}</span>}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Orders tab: full order table with client-side status filter chips + id
 * search, and per-row expand into a history timeline.
 *
 * History is fetched once per expand from `GET /orders?history=1` (cached in
 * `historyCache` keyed by order id, so re-collapsing/re-expanding the same
 * row doesn't refetch). That single endpoint already covers both persistence
 * states (see packages/api/src/routes/orders.ts): with a DB it swaps in
 * `transport_order_history` rows, without one it returns orders unchanged,
 * i.e. the same in-memory `history` already sitting in the live frame. The
 * frame's `order.history` is also used directly as a fallback if the fetch
 * itself fails (offline / API down), so the timeline never dead-ends.
 */
export function OrdersTab() {
  const t = useI18n((s) => s.t);
  const orders = useFleetStore((s) => s.frame?.orders ?? []);

  const [statusFilter, setStatusFilter] = useState<TransportOrder["status"] | "all">("all");
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | undefined>(undefined);
  const [historyCache, setHistoryCache] = useState<Record<string, OrderHistoryEntry[]>>({});
  const [loadingId, setLoadingId] = useState<string | undefined>(undefined);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return orders.filter((order) => {
      if (statusFilter !== "all" && order.status !== statusFilter) return false;
      if (needle && !order.id.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [orders, statusFilter, search]);

  async function toggleExpand(order: TransportOrder) {
    if (expandedId === order.id) {
      setExpandedId(undefined);
      return;
    }
    setExpandedId(order.id);
    if (historyCache[order.id]) return; // fetched once per expand — reuse the cached result

    setLoadingId(order.id);
    try {
      const res = await fetch("/orders?history=1");
      if (!res.ok) throw new Error(`GET /orders?history=1 failed: ${res.status}`);
      const data = (await res.json()) as OrdersHistoryResponse;
      const found = data.orders.find((o) => o.id === order.id);
      setHistoryCache((prev) => ({ ...prev, [order.id]: found?.history ?? order.history }));
    } catch {
      // Persistence off, or the fetch failed outright: fall back to the
      // order's own in-memory history, already present in the live frame.
      setHistoryCache((prev) => ({ ...prev, [order.id]: order.history }));
    } finally {
      setLoadingId(undefined);
    }
  }

  return (
    <section aria-label="Orders" className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-1" role="group" aria-label={t("status")}>
          <button
            type="button"
            data-testid="status-chip-all"
            onClick={() => setStatusFilter("all")}
            aria-pressed={statusFilter === "all"}
            className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
              statusFilter === "all"
                ? "bg-[var(--brand)] text-white"
                : "bg-white/[0.06] text-[var(--text)]/70 hover:text-[var(--text)]"
            }`}
          >
            {t("allStatuses")}
          </button>
          {ALL_STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              data-testid={`status-chip-${status}`}
              onClick={() => setStatusFilter(status)}
              aria-pressed={statusFilter === status}
              className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                statusFilter === status
                  ? "bg-[var(--brand)] text-white"
                  : "bg-white/[0.06] text-[var(--text)]/70 hover:text-[var(--text)]"
              }`}
            >
              {t(STATUS_LABEL_KEY[status])}
            </button>
          ))}
        </div>

        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("searchOrders")}
          aria-label={t("searchOrders")}
          className="ml-auto rounded-md border border-white/10 bg-[var(--surface-1)] px-2.5 py-1 text-sm text-[var(--text)] placeholder:text-[var(--text)]/40 focus:outline-none focus:ring-1 focus:ring-[var(--brand)]"
        />
      </div>

      <div className="flex-1 overflow-y-auto rounded-lg border border-white/10">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-white/10 text-xs uppercase tracking-wide text-[var(--text)]/50">
              <th className="px-3 py-2 font-medium">{t("orderId")}</th>
              <th className="px-3 py-2 font-medium">{t("route")}</th>
              <th className="px-3 py-2 font-medium">{t("status")}</th>
              <th className="px-3 py-2 font-medium">{t("robot")}</th>
              <th className="px-3 py-2 font-medium">{t("retries")}</th>
              <th className="px-3 py-2 font-medium">{t("createdAt")}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-xs text-[var(--text)]/50">
                  {t("noOrders")}
                </td>
              </tr>
            )}
            {filtered.map((order) => (
              <OrderRow
                key={order.id}
                order={order}
                expanded={expandedId === order.id}
                onToggle={() => toggleExpand(order)}
                historyEntries={historyCache[order.id]}
                loading={loadingId === order.id}
                t={t}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function OrderRow({
  order,
  expanded,
  onToggle,
  historyEntries,
  loading,
  t,
}: {
  order: TransportOrder;
  expanded: boolean;
  onToggle: () => void;
  historyEntries: OrderHistoryEntry[] | undefined;
  loading: boolean;
  t: (key: string) => string;
}) {
  return (
    <>
      <tr
        data-testid={`orders-row-${order.id}`}
        onClick={onToggle}
        aria-expanded={expanded}
        className="cursor-pointer border-b border-white/5 hover:bg-white/[0.03]"
      >
        <td className="px-3 py-2 font-mono-num">{order.id}</td>
        <td className="px-3 py-2 font-mono-num text-[var(--text)]/70">
          {order.pickupNode} → {order.dropNode}
        </td>
        <td className="px-3 py-2">
          <Badge color={ORDER_STATUS_COLORS[order.status]}>{t(STATUS_LABEL_KEY[order.status])}</Badge>
        </td>
        <td className="px-3 py-2 font-mono-num text-[var(--text)]/70">{order.robotId ?? "—"}</td>
        <td className="px-3 py-2 font-mono-num">{order.retries}</td>
        <td className="px-3 py-2 font-mono-num text-[var(--text)]/70">
          {new Date(order.createdAt).toLocaleString()}
        </td>
      </tr>
      {expanded && (
        <tr data-testid={`orders-history-${order.id}`} className="border-b border-white/5 bg-white/[0.02]">
          <td colSpan={6} className="px-3">
            <HistoryTimeline entries={historyEntries} loading={loading} />
          </td>
        </tr>
      )}
    </>
  );
}
