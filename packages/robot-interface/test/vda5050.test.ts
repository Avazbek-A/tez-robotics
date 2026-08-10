import { describe, it, expect } from "vitest";
import { WarehouseMap } from "@tez/core";
import { AgvController, VirtualAgvAdapter, type AgvId } from "vda-5050-lib";
import { startDevBroker, type DevBrokerResult } from "../src/dev-broker.js";
import { Vda5050Adapter } from "../src/vda5050.js";
import type { AdapterEvent, Mission } from "../src/adapter.js";

/**
 * Unit tests for `Vda5050Adapter`'s mapping logic, run against a real
 * `AgvController` + `VirtualAgvAdapter` counterpart (the same combination
 * locked down by the Task 3 spike, `test/spike.test.ts`) over an in-process
 * aedes broker — there is no lower-fidelity way to exercise real VDA 5050
 * wire behavior (order/order-update encoding, onOrderProcessed semantics,
 * connection tracking) without a live MQTT round trip.
 *
 * Each test builds its own broker (`port: 0`/`wsPort: 0`, see spike's port-
 * race note) and its own AGV/adapter pair rather than sharing one across
 * tests, trading a bit of duplication for full isolation and no cross-test
 * timing races.
 */

function grid3(): WarehouseMap {
  return WarehouseMap.fromJSON({
    nodes: [
      { id: "n0", pos: { x: 0, y: 0 } },
      { id: "n1", pos: { x: 1, y: 0 } },
      { id: "n2", pos: { x: 2, y: 0 } },
    ],
    edges: [
      { from: "n0", to: "n1", bidirectional: true },
      { from: "n1", to: "n2", bidirectional: true },
    ],
  });
}

async function waitFor(pred: () => boolean, timeoutMs: number, stepMs = 25): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

interface Rig {
  devBroker: DevBrokerResult;
  agvId: AgvId;
  agv: AgvController;
  adapter: Vda5050Adapter;
  events: AdapterEvent[];
  map: WarehouseMap;
  close(): Promise<void>;
}

async function buildRig(opts?: { vehicleSpeed?: number }): Promise<Rig> {
  const devBroker = await startDevBroker({ port: 0, wsPort: 0 });
  const map = grid3();
  const agvId: AgvId = { manufacturer: "tez", serialNumber: "sim-001" };

  const agv = new AgvController(
    agvId,
    { interfaceName: "uagv", transport: { brokerUrl: devBroker.url }, vdaVersion: "2.0.0" },
    { agvAdapterType: VirtualAgvAdapter, publishStateInterval: 200 },
    {
      initialPosition: { mapId: "warehouse", x: 0, y: 0, theta: 0, lastNodeId: "n0" },
      vehicleSpeed: opts?.vehicleSpeed ?? 5,
    }
  );
  await agv.start();

  const adapter = new Vda5050Adapter([{ manufacturer: "tez", serialNumber: "sim-001" }], devBroker.url, {
    interfaceName: "uagv",
  });
  const events: AdapterEvent[] = [];
  adapter.on((e) => events.push(e));
  await adapter.start();

  return {
    devBroker,
    agvId,
    agv,
    adapter,
    events,
    map,
    close: async () => {
      await adapter.stop();
      await agv.stop();
      await devBroker.close();
    },
  };
}

describe("Vda5050Adapter", () => {
  it(
    "sends a new mission and emits state heartbeats then missionDone",
    async () => {
      const rig = await buildRig();
      try {
        const mission: Mission = { id: "m1", robotId: "sim-001", nodeIds: ["n0", "n1"] };
        await rig.adapter.sendMission(mission, rig.map);

        await waitFor(
          () => rig.events.some((e) => e.type === "missionDone" && e.missionId === "m1"),
          20_000
        );

        const stateEvents = rig.events.filter((e) => e.type === "state");
        expect(stateEvents.length).toBeGreaterThan(0);
        for (const e of stateEvents) {
          if (e.type !== "state") continue;
          expect(e.state.id).toBe("sim-001");
          expect(e.state.battery).toBeGreaterThanOrEqual(0);
          expect(e.state.battery).toBeLessThanOrEqual(1);
        }

        const executing = stateEvents.some((e) => e.type === "state" && e.state.status === "EXECUTING");
        expect(executing).toBe(true);

        const done = rig.events.find((e) => e.type === "missionDone");
        expect(done).toMatchObject({ type: "missionDone", robotId: "sim-001", missionId: "m1" });
      } finally {
        await rig.close();
      }
    },
    25_000
  );

  it(
    "maps a strict-prefix-longer extension to a VDA order update (single missionDone, no duplicates)",
    async () => {
      const rig = await buildRig();
      try {
        const mission1: Mission = { id: "m1", robotId: "sim-001", nodeIds: ["n0", "n1"] };
        await rig.adapter.sendMission(mission1, rig.map);

        // Extend before the first leg finishes: same id, strict-prefix-longer.
        const mission2: Mission = { id: "m1", robotId: "sim-001", nodeIds: ["n0", "n1", "n2"] };
        await rig.adapter.sendMission(mission2, rig.map);

        await waitFor(
          () => rig.events.some((e) => e.type === "missionDone" && e.missionId === "m1"),
          20_000
        );

        // Give any late/duplicate settlement callbacks a chance to fire.
        await new Promise((r) => setTimeout(r, 500));

        const doneEvents = rig.events.filter((e) => e.type === "missionDone" && e.missionId === "m1");
        expect(doneEvents).toHaveLength(1);

        const failedEvents = rig.events.filter((e) => e.type === "missionFailed" && e.missionId === "m1");
        expect(failedEvents).toHaveLength(0);
      } finally {
        await rig.close();
      }
    },
    25_000
  );

  it(
    "rejects an extension that is not strictly longer than the tracked path",
    async () => {
      const rig = await buildRig();
      try {
        const mission1: Mission = { id: "m1", robotId: "sim-001", nodeIds: ["n0", "n1"] };
        await rig.adapter.sendMission(mission1, rig.map);

        const shorter: Mission = { id: "m1", robotId: "sim-001", nodeIds: ["n0"] };
        await expect(rig.adapter.sendMission(shorter, rig.map)).rejects.toThrow(/invalid mission extension/);
      } finally {
        await rig.close();
      }
    },
    25_000
  );

  it(
    "rejects an extension whose prefix does not match the tracked path",
    async () => {
      const rig = await buildRig();
      try {
        const mission1: Mission = { id: "m1", robotId: "sim-001", nodeIds: ["n0", "n1"] };
        await rig.adapter.sendMission(mission1, rig.map);

        const mismatched: Mission = { id: "m1", robotId: "sim-001", nodeIds: ["n0", "n2"] };
        await expect(rig.adapter.sendMission(mismatched, rig.map)).rejects.toThrow(
          /invalid mission extension/
        );
      } finally {
        await rig.close();
      }
    },
    25_000
  );

  it(
    "cancelMission cancels the order without emitting missionDone/missionFailed for it",
    async () => {
      // Slow vehicle speed so there's ample time to cancel before the AGV
      // would otherwise reach the end of the (longer) path on its own.
      const rig = await buildRig({ vehicleSpeed: 0.2 });
      try {
        const mission: Mission = { id: "m1", robotId: "sim-001", nodeIds: ["n0", "n1", "n2"] };
        await rig.adapter.sendMission(mission, rig.map);
        await rig.adapter.cancelMission("sim-001");

        // Let the cancellation round-trip and settle.
        await new Promise((r) => setTimeout(r, 2_000));

        const terminalForM1 = rig.events.filter(
          (e) => (e.type === "missionDone" || e.type === "missionFailed") && e.missionId === "m1"
        );
        expect(terminalForM1).toHaveLength(0);

        // The robot must be free to accept a brand-new mission afterwards.
        const mission2: Mission = { id: "m2", robotId: "sim-001", nodeIds: ["n0"] };
        await expect(rig.adapter.sendMission(mission2, rig.map)).resolves.toBeUndefined();
      } finally {
        await rig.close();
      }
    },
    25_000
  );

  it(
    "emits a connection offline event when the AGV disconnects",
    async () => {
      const rig = await buildRig();
      try {
        await waitFor(
          () => rig.events.some((e) => e.type === "connection" && e.online === true),
          10_000
        );

        await rig.agv.stop();

        await waitFor(
          () => rig.events.some((e) => e.type === "connection" && e.online === false),
          10_000
        );
      } finally {
        await rig.adapter.stop();
        await rig.devBroker.close();
      }
    },
    25_000
  );
});
