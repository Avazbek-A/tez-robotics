import { WarehouseMap } from "@tez/core";

/** Raw {nodes,edges} map data for the demo mode, an 8x8 grid. */
export const DEMO_MAP: unknown = WarehouseMap.grid(8, 8);

/**
 * Deterministic start nodes for demo-mode robots, spread across the 8x8
 * grid's corners/edges to avoid collisions. First three cover distinct
 * corners of the grid; additional entries fill further corners/edges as
 * more robots are configured.
 */
export const DEMO_START_NODES: string[] = [
  "n1_1",
  "n6_1",
  "n1_6",
  "n6_6",
  "n3_1",
  "n1_3",
  "n6_3",
  "n3_6",
];
