import { useState } from "react";
import { useI18n } from "../i18n";
import { Drawer } from "./ui/drawer";

export interface AlarmDrawerProps {
  /** Chronological (oldest-first), as sent by the server — see packages/api/src/ws.ts's StateFrame.alarms. */
  alarms: string[];
}

/**
 * Header alarm indicator: a badge showing the alarm count, opening a
 * slide-over listing every alarm newest-first on click. Self-contained
 * (owns its own open/closed state) so it can be dropped straight into the
 * header.
 */
export function AlarmDrawer({ alarms }: AlarmDrawerProps) {
  const t = useI18n((s) => s.t);
  const [open, setOpen] = useState(false);
  const newestFirst = [...alarms].reverse();

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={t("alarms")}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
          alarms.length > 0
            ? "border-[#ef4444]/40 bg-[#ef4444]/10 text-[#ef4444]"
            : "border-white/10 bg-[var(--surface-1)] text-[var(--text)]/70"
        }`}
      >
        {t("alarms")}
        <span className="font-mono-num rounded-full bg-black/20 px-1.5">{alarms.length}</span>
      </button>

      <Drawer open={open} onClose={() => setOpen(false)} title={t("alarms")}>
        {newestFirst.length === 0 ? (
          <p className="text-sm text-[var(--text)]/50">{t("noAlarms")}</p>
        ) : (
          <ul className="space-y-2">
            {newestFirst.map((alarm, i) => (
              <li
                key={`${i}-${alarm}`}
                className="rounded-md border border-[#ef4444]/20 bg-[#ef4444]/5 px-2 py-1.5 text-xs text-[var(--text)]/90"
              >
                {alarm}
              </li>
            ))}
          </ul>
        )}
      </Drawer>
    </>
  );
}
