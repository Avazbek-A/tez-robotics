import { useI18n } from "../i18n";

export interface KpiRowProps {
  ordersPerHour: number;
  avgCycleMs: number;
  /** 0..1 fraction, rendered as a percentage. */
  utilization: number;
  queueDepth: number;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-[var(--text)]/50">{label}</span>
      <span className="font-mono-num text-xl font-semibold leading-none">{value}</span>
    </div>
  );
}

/** Bottom-strip KPI numerals: orders/h, avg cycle (s), utilization (%), queue depth. */
export function KpiRow({ ordersPerHour, avgCycleMs, utilization, queueDepth }: KpiRowProps) {
  const t = useI18n((s) => s.t);
  const avgCycleS = (avgCycleMs / 1000).toFixed(1);
  const utilPct = Math.round(utilization * 100);

  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4" aria-label={t("kpiTitle")}>
      <Stat label={t("kpiRate")} value={ordersPerHour.toFixed(1)} />
      <Stat label={t("kpiCycle")} value={avgCycleS} />
      <Stat label={t("kpiUtil")} value={`${utilPct}%`} />
      <Stat label={t("kpiQueue")} value={String(queueDepth)} />
    </div>
  );
}
