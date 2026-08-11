import { create } from "zustand";
import { useI18n } from "./i18n";
import type { Lang } from "./i18n";

type Tab = "cockpit" | "orders" | "analytics";

interface UiState {
  tab: Tab;
  setTab: (tab: Tab) => void;
}

export const useUiStore = create<UiState>((set) => ({
  tab: "cockpit",
  setTab: (tab) => set({ tab }),
}));

const LANGS: Lang[] = ["ru", "uz", "en"];

function ConnectionChip() {
  const t = useI18n((s) => s.t);
  // Placeholder pending the WS client (later task): shows "reconnecting"
  // state until the real /ws connection is wired up.
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-[var(--surface-1)] px-2.5 py-1 text-xs">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden="true" />
      {t("connection")}: {t("reconnecting")}
    </span>
  );
}

function LangSwitcher() {
  const lang = useI18n((s) => s.lang);
  const setLang = useI18n((s) => s.setLang);

  return (
    <div className="flex gap-1" role="group" aria-label="Language">
      {LANGS.map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => setLang(l)}
          aria-pressed={lang === l}
          className={`font-mono-num rounded px-2 py-1 text-xs uppercase transition-colors ${
            lang === l
              ? "bg-[var(--brand)] text-white"
              : "text-[var(--text)]/60 hover:text-[var(--text)]"
          }`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

const TABS: { key: Tab; labelKey: "tabCockpit" | "tabOrders" | "tabAnalytics" }[] = [
  { key: "cockpit", labelKey: "tabCockpit" },
  { key: "orders", labelKey: "tabOrders" },
  { key: "analytics", labelKey: "tabAnalytics" },
];

function TabBar() {
  const tab = useUiStore((s) => s.tab);
  const setTab = useUiStore((s) => s.setTab);
  const t = useI18n((s) => s.t);

  return (
    <nav className="flex gap-1 border-b border-white/10 px-4" aria-label="Sections">
      {TABS.map(({ key, labelKey }) => (
        <button
          key={key}
          type="button"
          onClick={() => setTab(key)}
          aria-current={tab === key ? "page" : undefined}
          className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
            tab === key
              ? "border-[var(--brand)] text-[var(--text)]"
              : "border-transparent text-[var(--text)]/60 hover:text-[var(--text)]"
          }`}
        >
          {t(labelKey)}
        </button>
      ))}
    </nav>
  );
}

export default function App() {
  const tab = useUiStore((s) => s.tab);

  return (
    <div className="flex min-h-screen flex-col bg-[var(--surface-0)] text-[var(--text)]">
      <header className="flex items-center justify-between border-b border-white/10 bg-[var(--surface-1)] px-4 py-3">
        <span className="text-base font-semibold tracking-tight">Tez Robotics</span>
        <div className="flex items-center gap-3">
          <ConnectionChip />
          <LangSwitcher />
        </div>
      </header>

      <TabBar />

      <main className="flex-1 p-4">
        {tab === "cockpit" && <section aria-label="Cockpit" />}
        {tab === "orders" && <section aria-label="Orders" />}
        {tab === "analytics" && <section aria-label="Analytics" />}
      </main>
    </div>
  );
}
