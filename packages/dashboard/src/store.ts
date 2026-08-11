import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { StateFrame } from "./types";

export type ConnectionState = "connecting" | "connected" | "reconnecting";

/** One rolling sample of `StateFrame.kpis`, timestamped client-side (`Date.now()`). */
export interface KpiSample {
  t: number;
  kpis: StateFrame["kpis"];
}

/** Cap on `FleetState.kpiBuffer` — oldest samples are dropped once exceeded. */
export const KPI_BUFFER_CAP = 600;

export interface FleetState {
  connection: ConnectionState;
  frame?: StateFrame; // latest full frame
  lastFrameAt?: number;
  /**
   * Rolling client-side buffer of KPI samples, one appended per applyFrame,
   * capped at KPI_BUFFER_CAP (oldest dropped first). Used by AnalyticsTab as
   * a live sparkline fallback when the server has no persisted `kpi_snapshots`
   * range to offer (GET /kpi?from=&to= returns `range: null`, i.e.
   * persistence is off) — see packages/api/src/routes/kpi.ts.
   */
  kpiBuffer: KpiSample[];
  applyFrame(f: StateFrame): void;
  setConnection(c: ConnectionState): void;
  selectedRobotId?: string;
  selectRobot(id?: string): void;
}

// Vanilla store: not a React hook. Non-React consumers (the Pixi canvas)
// subscribe directly via `fleetStore.subscribe(listener)` / read via
// `fleetStore.getState()`, avoiding a React re-render on every 100ms frame.
export const fleetStore: StoreApi<FleetState> = createStore<FleetState>((set, get) => ({
  connection: "connecting",
  frame: undefined,
  lastFrameAt: undefined,
  kpiBuffer: [],
  selectedRobotId: undefined,
  applyFrame: (f) => {
    const now = Date.now();
    const nextBuffer = [...get().kpiBuffer, { t: now, kpis: f.kpis }];
    if (nextBuffer.length > KPI_BUFFER_CAP) nextBuffer.splice(0, nextBuffer.length - KPI_BUFFER_CAP);
    set({ frame: f, lastFrameAt: now, kpiBuffer: nextBuffer });
  },
  setConnection: (c) => set({ connection: c }),
  selectRobot: (id) => set({ selectedRobotId: id }),
}));

// React hook bound to the same vanilla store, for components that do want
// re-renders (connection chip, KPI panel, etc.).
export function useFleetStore(): FleetState;
export function useFleetStore<T>(selector: (state: FleetState) => T): T;
export function useFleetStore<T>(selector?: (state: FleetState) => T): T | FleetState {
  return selector ? useStore(fleetStore, selector) : useStore(fleetStore);
}
