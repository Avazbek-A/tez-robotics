import { readFile } from "node:fs/promises";
import { WarehouseMap } from "@tez/core";
import { AgvController, VirtualAgvAdapter, type AgvId, type ClientOptions, type VdaVersion } from "vda-5050-lib";

/**
 * `mapId` used for every simulated AGV's `initialPosition` and, transitively
 * (since `VirtualAgvAdapter` requires the vehicle to already be positioned
 * "on" a released order's first node within its deviation tolerance), for
 * every order node's `nodePosition.mapId` it will ever be sent. This MUST
 * match the `MAP_ID` constant `Vda5050Adapter` (in `@tez/robot-interface`)
 * hardcodes onto every `sendMission`-built VDA node — see that file's
 * private `MAP_ID = "warehouse"` constant, not exported, hence duplicated
 * here rather than imported. `packages/orchestrator/test/vda5050-integration.test.ts`
 * relies on the same coupling.
 */
const MAP_ID = "warehouse";

const MANUFACTURER = "tez";

export interface FailRobotSpec {
  /** Simulated AGV serial number, e.g. "sim-003" (as returned in `agvIds`). */
  id: string;
  /** Seconds after `spawnFleet()` resolves at which to kill this robot. */
  atSec: number;
}

export interface SpawnFleetOpts {
  /** Path to a `WarehouseMap.fromJSON`-shaped map file (nodes + edges). */
  mapPath: string;
  /** Number of virtual AGVs to spawn, ids minted `sim-001`..`sim-{robots}`. */
  robots: number;
  /** MQTT broker URL every AGV connects to (e.g. `mqtt://localhost:1883`). */
  mqttUrl: string;
  /** VDA 5050 communication namespace. Defaults to "uagv" (must match the orchestrator side's `Vda5050Adapter`/`MasterController`). */
  interfaceName?: string;
  /** Protocol version. Defaults to "2.0.0" (must match the orchestrator side). */
  vdaVersion?: VdaVersion;
  /** Robots to kill (`AgvController.stop()`, i.e. a hard MQTT disconnect — not a graceful mission handoff) at a given wall-clock offset, simulating a robot going dark mid-fleet. */
  failRobot?: FailRobotSpec[];
}

export interface SpawnedFleet {
  /** Serial numbers of every spawned AGV, in spawn order (`sim-001`, `sim-002`, ...). */
  agvIds: string[];
  /** Cancels any pending failure-injection timers and disconnects every still-live AGV. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Chooses `n` start node ids "spread over the map" per the task brief:
 * prefer the charger column/row (nodes with `charger: true`, e.g. the x=0
 * column on `WarehouseMap.grid`-shaped maps) when there are enough of them,
 * falling back to the map's first `n` node ids otherwise. Either pool is
 * sorted by `(y, x)` rather than raw id string so a real (non-single-digit)
 * grid's row ordering ("n0_2" before "n0_10") isn't corrupted by lexical
 * sort.
 */
function pickStartNodes(map: WarehouseMap, n: number): string[] {
  const byGridOrder = (ids: string[]): string[] =>
    ids.slice().sort((a, b) => {
      const pa = map.node(a).pos;
      const pb = map.node(b).pos;
      return pa.y - pb.y || pa.x - pb.x;
    });

  const chargerIds = byGridOrder(map.nodeIds.filter((id) => map.node(id).charger));
  const pool = chargerIds.length >= n ? chargerIds : byGridOrder(map.nodeIds);

  if (pool.length < n) {
    throw new Error(`spawnFleet: map has only ${pool.length} usable start nodes, need ${n}`);
  }
  return pool.slice(0, n);
}

function robotSerial(index: number): string {
  return `sim-${String(index + 1).padStart(3, "0")}`;
}

/**
 * Spawns `opts.robots` in-process virtual AGVs (via `vda-5050-lib`'s
 * `AgvController` + `VirtualAgvAdapter` — the same pairing locked down by
 * the Task 3 protocol spike, see `packages/robot-interface/test/spike.test.ts`)
 * against the given map and MQTT broker. Battery/charge behavior is left at
 * `VirtualAgvAdapter`'s own defaults (100% initial charge, ~4h reach at
 * 2m/s, 1h full recharge) — nothing here overrides them.
 *
 * Resolves only once every AGV has connected (`AgvController.start()`
 * awaited in spawn order), so a caller awaiting this can immediately start
 * assigning orders to any id in the returned `agvIds`.
 */
export async function spawnFleet(opts: SpawnFleetOpts): Promise<SpawnedFleet> {
  if (opts.robots <= 0) {
    throw new Error(`spawnFleet: robots must be > 0, got ${opts.robots}`);
  }

  const raw = await readFile(opts.mapPath, "utf-8");
  const map = WarehouseMap.fromJSON(JSON.parse(raw));
  const startNodeIds = pickStartNodes(map, opts.robots);

  const clientOptions: ClientOptions = {
    interfaceName: opts.interfaceName ?? "uagv",
    transport: { brokerUrl: opts.mqttUrl },
    vdaVersion: opts.vdaVersion ?? "2.0.0",
  };

  const agvIds: string[] = [];
  const controllers: AgvController[] = [];

  for (let i = 0; i < opts.robots; i++) {
    const serialNumber = robotSerial(i);
    const startNodeId = startNodeIds[i]!;
    const pos = map.node(startNodeId).pos;
    const agvId: AgvId = { manufacturer: MANUFACTURER, serialNumber };

    const controller = new AgvController(
      agvId,
      clientOptions,
      // `publishStateInterval` MUST be set well below `Orchestrator`'s
      // `tickMs` (200ms here, and in the fleet integration test this
      // mirrors) — `AgvControllerOptions`' own default is 30_000ms (see
      // `agv-controller.js`'s `_controllerOptionsWithDefaults`), which
      // starves the orchestrator's per-tick single-cell mission-extension
      // pipeline of fresh position/lastNodeId telemetry to react to.
      // Confirmed empirically: omitting this collapsed a ~10-cell,
      // sub-10s hop into 60s+ of near-stall. Matches the value already
      // proven in `packages/orchestrator/test/vda5050-integration.test.ts`.
      { agvAdapterType: VirtualAgvAdapter, publishStateInterval: 100 },
      { initialPosition: { mapId: MAP_ID, x: pos.x, y: pos.y, theta: 0, lastNodeId: startNodeId } }
    );
    await controller.start();

    agvIds.push(serialNumber);
    controllers.push(controller);
  }

  const failTimers: ReturnType<typeof setTimeout>[] = [];
  for (const spec of opts.failRobot ?? []) {
    const idx = agvIds.indexOf(spec.id);
    if (idx === -1) {
      // Unknown id: not a reason to abort spawning the rest of the fleet —
      // logged so a typo'd `--fail-robot` flag is still discoverable.
      // eslint-disable-next-line no-console
      console.warn(`spawnFleet: --fail-robot targets unknown robot id "${spec.id}", ignoring`);
      continue;
    }
    const controller = controllers[idx]!;
    const delayMs = Math.max(0, spec.atSec) * 1000;
    failTimers.push(
      setTimeout(() => {
        // Best-effort: a robot that's already stopped (e.g. the fleet is
        // shutting down at the same moment) shouldn't throw an unhandled
        // rejection out of a timer callback.
        void controller.stop().catch(() => {});
      }, delayMs)
    );
  }

  let stopped = false;
  return {
    agvIds,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      for (const timer of failTimers) clearTimeout(timer);
      await Promise.all(controllers.map((c) => c.stop().catch(() => {})));
    },
  };
}
