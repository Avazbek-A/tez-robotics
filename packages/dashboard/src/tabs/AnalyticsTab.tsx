import { useEffect, useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useI18n } from "../i18n";
import { useFleetStore } from "../store";

/**
 * `kpi_snapshots` DB row, as returned by GET /kpi?from=&to= (see
 * packages/api/src/routes/kpi.ts's KpiRowSchema). `id` is a bigserial —
 * pglite returns `number`, node-postgres returns `string`.
 */
interface KpiSnapshotRow {
  id: string | number;
  at: string;
  orders_per_hour: number;
  avg_cycle_ms: number;
  utilization: number;
}

interface KpiResponse {
  live: { ordersPerHour: number; avgCycleMs: number; utilization: number };
  range?: KpiSnapshotRow[] | null;
  note?: string;
}

/** One point on all three charts' shared x-axis (time). */
interface ChartPoint {
  t: number;
  ordersPerHour: number;
  avgCycleS: number;
  utilizationPct: number;
}

const RANGE_MS = 60 * 60 * 1000; // last hour, per brief
const REFETCH_MS = 30_000;

function formatTime(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Polls GET /kpi?from=&to= (last hour) every 30s. Returns `range: null` when
 * the server has no persisted `kpi_snapshots` (persistence off) — the
 * caller falls back to the client-side rolling buffer in that case.
 */
function useKpiRange(): { range: KpiSnapshotRow[] | null; note: string | undefined } {
  const [range, setRange] = useState<KpiSnapshotRow[] | null>(null);
  const [note, setNote] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const to = new Date();
      const from = new Date(to.getTime() - RANGE_MS);
      try {
        const res = await fetch(`/kpi?from=${from.toISOString()}&to=${to.toISOString()}`);
        if (!res.ok) throw new Error(`GET /kpi failed: ${res.status}`);
        const data = (await res.json()) as KpiResponse;
        if (cancelled) return;
        setRange(data.range ?? null);
        setNote(data.note);
      } catch {
        if (cancelled) return;
        setRange(null);
      }
    }

    void load();
    const id = setInterval(load, REFETCH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return { range, note };
}

function AnalyticsChart({
  title,
  data,
  dataKey,
  color,
  valueFormatter,
}: {
  title: string;
  data: ChartPoint[];
  dataKey: keyof ChartPoint;
  color: string;
  valueFormatter: (v: number) => string;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-[var(--surface-1)] p-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text)]/60">{title}</h3>
      <div className="h-40 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={`fill-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={color} stopOpacity={0.4} />
                <stop offset="95%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
            <XAxis
              dataKey="t"
              tickFormatter={formatTime}
              tick={{ fontSize: 10, fill: "rgba(255,255,255,0.5)" }}
              minTickGap={40}
            />
            <YAxis
              tick={{ fontSize: 10, fill: "rgba(255,255,255,0.5)" }}
              tickFormatter={valueFormatter}
              width={40}
            />
            <Tooltip
              labelFormatter={(v) => formatTime(Number(v))}
              formatter={(value) => valueFormatter(Number(value))}
            />
            <Area type="monotone" dataKey={dataKey} stroke={color} fill={`url(#fill-${dataKey})`} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/**
 * Analytics tab: three Recharts AreaCharts (orders/h, utilization %, avg
 * cycle s) over the last hour. Prefers the persisted `kpi_snapshots` range
 * (GET /kpi?from=&to=, refetched every 30s); when persistence is off the
 * server returns `range: null` and this falls back to the store's rolling
 * `kpiBuffer` (client-side samples, one per WS frame, capped at 600) so the
 * charts still show a live sparkline instead of going empty.
 */
export function AnalyticsTab() {
  const t = useI18n((s) => s.t);
  const { range, note } = useKpiRange();
  const kpiBuffer = useFleetStore((s) => s.kpiBuffer);

  const data = useMemo<ChartPoint[]>(() => {
    if (range) {
      return range.map((row) => ({
        t: new Date(row.at).getTime(),
        ordersPerHour: row.orders_per_hour,
        avgCycleS: row.avg_cycle_ms / 1000,
        utilizationPct: row.utilization * 100,
      }));
    }
    const cutoff = Date.now() - RANGE_MS;
    return kpiBuffer
      .filter((sample) => sample.t >= cutoff)
      .map((sample) => ({
        t: sample.t,
        ordersPerHour: sample.kpis.ordersPerHour,
        avgCycleS: sample.kpis.avgCycleMs / 1000,
        utilizationPct: sample.kpis.utilization * 100,
      }));
  }, [range, kpiBuffer]);

  return (
    <section aria-label="Analytics" className="flex h-full flex-col gap-3">
      {range === null && (
        <p className="text-xs text-[var(--text)]/50">{note ?? t("liveOnly")}</p>
      )}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <AnalyticsChart
          title={t("kpiRate")}
          data={data}
          dataKey="ordersPerHour"
          color="#4f46e5"
          valueFormatter={(v) => v.toFixed(1)}
        />
        <AnalyticsChart
          title={t("kpiUtil")}
          data={data}
          dataKey="utilizationPct"
          color="#22c55e"
          valueFormatter={(v) => `${Math.round(v)}%`}
        />
        <AnalyticsChart
          title={t("kpiCycle")}
          data={data}
          dataKey="avgCycleS"
          color="#f59e0b"
          valueFormatter={(v) => v.toFixed(1)}
        />
      </div>
    </section>
  );
}
