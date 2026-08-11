import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { StateFrame } from "./types";

export type ConnectionState = "connecting" | "connected" | "reconnecting";

export interface FleetState {
  connection: ConnectionState;
  frame?: StateFrame; // latest full frame
  lastFrameAt?: number;
  applyFrame(f: StateFrame): void;
  setConnection(c: ConnectionState): void;
  selectedRobotId?: string;
  selectRobot(id?: string): void;
}

// Vanilla store: not a React hook. Non-React consumers (the Pixi canvas)
// subscribe directly via `fleetStore.subscribe(listener)` / read via
// `fleetStore.getState()`, avoiding a React re-render on every 100ms frame.
export const fleetStore: StoreApi<FleetState> = createStore<FleetState>((set) => ({
  connection: "connecting",
  frame: undefined,
  lastFrameAt: undefined,
  selectedRobotId: undefined,
  applyFrame: (f) => set({ frame: f, lastFrameAt: Date.now() }),
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
