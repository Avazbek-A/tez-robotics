import { useEffect } from "react";
import { create } from "zustand";
import { useI18n } from "./i18n";
import type { Lang } from "./i18n";
import PixiMap from "./map/PixiMap";
import { fleetStore, useFleetStore } from "./store";
import { startWsClient } from "./ws-client";
import type { TransportOrder } from "./types";
import { RobotCard } from "./components/RobotCard";
import { TaskQueue } from "./components/TaskQueue";
import { KpiRow } from "./components/KpiRow";
import { AlarmDrawer } from "./components/AlarmDrawer";
import { OrdersTab } from "./tabs/OrdersTab";
import { AnalyticsTab } from "./tabs/AnalyticsTab";

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
  // `t` alone is a stable closure reference (it never changes identity
  // when lang changes — it reads current lang via `get()` internally),
  // so a selector on `t` alone never re-renders this component on lang
  // switch. Also selecting `lang` (a primitive, so reference-equality
  // works fine) forces the re-render whenever it differs; `t` then
  // reads the fresh lang when called during that render.
  const lang = useI18n((s) => s.lang);
  const t = useI18n((s) => s.t);
  void lang; // subscription-only: forces re-render, not read directly

  const connection = useFleetStore((s) => s.connection);
  const dotColor =
    connection === "connected" ? "bg-emerald-400" : connection === "connecting" ? "bg-amber-400" : "bg-red-400";
  const label = connection === "connected" ? t("connected") : connection === "connecting" ? t("connecting") : t("reconnecting");

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-[var(--surface-1)] px-2.5 py-1 text-xs">
      <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} aria-hidden="true" />
      {t("connection")}: {label}
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
  // See ConnectionChip above: also select `lang` so this component
  // re-renders on lang switch (a `t`-only selector never does).
  const lang = useI18n((s) => s.lang);
  const t = useI18n((s) => s.t);
  void lang; // subscription-only: forces re-render, not read directly

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

/** A robot's in-flight order: the one order (if any) it's dispatched/underway on. */
function findCurrentOrder(robotId: string, orders: TransportOrder[]): TransportOrder | undefined {
  return orders.find(
    (o) => o.robotId === robotId && (o.status === "dispatched" || o.status === "underway"),
  );
}

function FleetRail() {
  const t = useI18n((s) => s.t);
  const robots = useFleetStore((s) => s.frame?.robots ?? []);
  const orders = useFleetStore((s) => s.frame?.orders ?? []);
  const selectedRobotId = useFleetStore((s) => s.selectedRobotId);
  const selectRobot = useFleetStore((s) => s.selectRobot);

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--text)]/60">
        {t("fleetTitle")}
      </h2>
      {robots.length === 0 && <p className="text-xs text-[var(--text)]/50">{t("noRobots")}</p>}
      {robots.map((robot) => (
        <RobotCard
          key={robot.id}
          robot={robot}
          currentOrder={findCurrentOrder(robot.id, orders)}
          selected={robot.id === selectedRobotId}
          onSelect={selectRobot}
        />
      ))}
    </div>
  );
}

function CockpitBottomStrip() {
  const orders = useFleetStore((s) => s.frame?.orders ?? []);
  const kpis = useFleetStore((s) => s.frame?.kpis);
  const queueDepth = orders.filter((o) => o.status === "queued").length;

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-4 overflow-hidden sm:grid-cols-[1fr_auto]">
      <TaskQueue orders={orders} />
      <div className="border-t border-white/10 pt-2 sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0">
        <KpiRow
          ordersPerHour={kpis?.ordersPerHour ?? 0}
          avgCycleMs={kpis?.avgCycleMs ?? 0}
          utilization={kpis?.utilization ?? 0}
          queueDepth={queueDepth}
        />
      </div>
    </div>
  );
}

/**
 * Cockpit CSS grid: map center (1fr), right rail (320px, scrollable
 * RobotCard list), bottom strip (TaskQueue + KpiRow) spanning both columns.
 */
function Cockpit() {
  return (
    <section
      aria-label="Cockpit"
      className="grid h-[calc(100vh-8.5rem)] gap-3"
      style={{
        gridTemplateColumns: "1fr 320px",
        gridTemplateRows: "1fr 200px",
        gridTemplateAreas: '"map rail" "bottom bottom"',
      }}
    >
      <div
        style={{ gridArea: "map" }}
        className="overflow-hidden rounded-lg border border-white/10 bg-[var(--surface-1)]"
      >
        <PixiMap />
      </div>
      <div
        style={{ gridArea: "rail" }}
        className="overflow-hidden rounded-lg border border-white/10 bg-[var(--surface-1)] p-3"
      >
        <FleetRail />
      </div>
      <div
        style={{ gridArea: "bottom" }}
        className="min-h-0 overflow-hidden rounded-lg border border-white/10 bg-[var(--surface-1)] p-3"
      >
        <CockpitBottomStrip />
      </div>
    </section>
  );
}

export default function App() {
  const tab = useUiStore((s) => s.tab);
  const alarms = useFleetStore((s) => s.frame?.alarms ?? []);

  // Live WS connection: mirrors every /ws/state frame into fleetStore for
  // the whole app (map, right rail, task queue, KPIs, alarms) to read.
  // Guarded on `window.WebSocket` existing: happy-dom (the test
  // environment) doesn't implement it, so this becomes a safe no-op there
  // instead of throwing during the effect.
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.WebSocket === "undefined") return;
    const client = startWsClient(`ws://${window.location.host}/ws/state`, fleetStore);
    return () => client.stop();
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-[var(--surface-0)] text-[var(--text)]">
      <header className="flex items-center justify-between border-b border-white/10 bg-[var(--surface-1)] px-4 py-3">
        <span className="text-base font-semibold tracking-tight">Tez Robotics</span>
        <div className="flex items-center gap-3">
          <AlarmDrawer alarms={alarms} />
          <ConnectionChip />
          <LangSwitcher />
        </div>
      </header>

      <TabBar />

      <main className="flex-1 p-4">
        {tab === "cockpit" && <Cockpit />}
        {tab === "orders" && <OrdersTab />}
        {tab === "analytics" && <AnalyticsTab />}
      </main>
    </div>
  );
}
