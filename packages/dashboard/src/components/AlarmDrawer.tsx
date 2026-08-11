import { useState } from "react";
import { useI18n } from "../i18n";
import { Drawer } from "./ui/drawer";

export interface AlarmDrawerProps {
  /** Chronological (oldest-first), as sent by the server — see packages/api/src/ws.ts's StateFrame.alarms. */
  alarms: string[];
}

/**
 * The orchestrator's alarm log mixes two very different severities in one
 * string channel: real faults (robot offline, mission failure, quarantine)
 * and routine PIBT traffic coordination ("contention: robot A could not
 * claim cell X (owner=B)" — robot A yields one tick; by design, not a
 * fault). With a dense fleet the contention lines dominate by orders of
 * magnitude and would make the red badge read as a system failure.
 * Splitting the channel server-side needs an orchestrator change (out of
 * this branch's edit scope — see docs/PLAN2-HOOK-REQUESTS.md), so the
 * split happens here by string match on the stable "contention:" marker
 * the router emits.
 */
const isTraffic = (alarm: string) => alarm.includes("contention:");

/**
 * Header alarm indicator: a red badge counting REAL alarms only, opening a
 * slide-over with two sections — faults (red) and traffic-coordination
 * events (neutral, collapsed into their own list). Self-contained (owns
 * its own open/closed state) so it can be dropped straight into the
 * header.
 */
export function AlarmDrawer({ alarms }: AlarmDrawerProps) {
  // See App.tsx's ConnectionChip: `t` alone is a stable closure reference
  // that never changes identity on lang switch, so a `t`-only selector never
  // re-renders this component when lang changes. Also selecting `lang`
  // forces the re-render; `t` then reads the fresh lang when called during
  // that render.
  const lang = useI18n((s) => s.lang);
  const t = useI18n((s) => s.t);
  void lang; // subscription-only: forces re-render, not read directly
  const [open, setOpen] = useState(false);

  const faults = alarms.filter((a) => !isTraffic(a));
  const traffic = alarms.filter(isTraffic);
  const faultsNewestFirst = [...faults].reverse();
  const trafficNewestFirst = [...traffic].reverse();

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={t("alarms")}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
          faults.length > 0
            ? "border-[#ef4444]/40 bg-[#ef4444]/10 text-[#ef4444]"
            : "border-white/10 bg-[var(--surface-1)] text-[var(--text)]/70"
        }`}
      >
        {t("alarms")}
        <span className="font-mono-num rounded-full bg-black/20 px-1.5">{faults.length}</span>
        {traffic.length > 0 && (
          <span
            className="font-mono-num rounded-full border border-white/10 bg-[var(--surface-1)] px-1.5 text-[var(--text)]/50"
            title={t("traffic")}
          >
            {traffic.length}
          </span>
        )}
      </button>

      <Drawer open={open} onClose={() => setOpen(false)} title={t("alarms")}>
        {faultsNewestFirst.length === 0 ? (
          <p className="text-sm text-[var(--text)]/50">{t("noAlarms")}</p>
        ) : (
          <ul className="space-y-2">
            {faultsNewestFirst.map((alarm, i) => (
              <li
                key={`${i}-${alarm}`}
                className="rounded-md border border-[#ef4444]/20 bg-[#ef4444]/5 px-2 py-1.5 text-xs text-[var(--text)]/90"
              >
                {alarm}
              </li>
            ))}
          </ul>
        )}

        {trafficNewestFirst.length > 0 && (
          <>
            <h3 className="mt-5 mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text)]/50">
              {t("traffic")}{" "}
              <span className="font-mono-num normal-case text-[var(--text)]/40">({trafficNewestFirst.length})</span>
            </h3>
            <p className="mb-2 text-xs text-[var(--text)]/40">{t("trafficHint")}</p>
            <ul className="space-y-1.5">
              {trafficNewestFirst.map((alarm, i) => (
                <li
                  key={`${i}-${alarm}`}
                  className="rounded-md border border-white/5 bg-[var(--surface-1)] px-2 py-1.5 text-xs text-[var(--text)]/60"
                >
                  {alarm}
                </li>
              ))}
            </ul>
          </>
        )}
      </Drawer>
    </>
  );
}
