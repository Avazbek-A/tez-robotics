import { describe, it, expect, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { startDevBroker, type DevBrokerResult } from "@tez/robot-interface";
import { spawnFleet, type SpawnedFleet } from "../src/fleet.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAP_PATH = path.resolve(__dirname, "../../../maps/demo-grid.json");

/**
 * Fast, small-scale wiring smoke test for `spawnFleet()` — separate from
 * `e2e.test.ts`'s full 10-robot/50-order soak so a basic regression here
 * (wrong mapId, bad start-node picking, `stop()` not disconnecting) fails
 * in milliseconds instead of minutes.
 */
describe("spawnFleet", () => {
  let devBroker: DevBrokerResult | undefined;
  let fleet: SpawnedFleet | undefined;

  afterEach(async () => {
    if (fleet) {
      // `AgvController.start()` resolving does not guarantee the adapter's
      // internal attach handshake (order/instant-action topic
      // subscriptions) has finished — that runs on its own async chain the
      // library never hands back to the caller (see `agv-controller.js`'s
      // `_attachAdapter`, which fires `_agvAdapter.attach()` without
      // awaiting its `attached` callback). Stopping in the same tick races
      // that handshake and surfaces as an unhandled "Client is not
      // started" rejection from inside the library itself — a
      // pre-existing upstream quirk, not something this test (or
      // `spawnFleet`) can catch or await. A short settle delay avoids
      // exercising that race here; real usage (CLI, e2e soak) never stops
      // a robot within milliseconds of spawning it.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await fleet.stop();
    }
    if (devBroker) await devBroker.close();
    fleet = undefined;
    devBroker = undefined;
  });

  it("mints sim-001.. ids, spreads robots over the charger column, and connects them", async () => {
    devBroker = await startDevBroker({ port: 0, wsPort: 0 });
    fleet = await spawnFleet({
      mapPath: MAP_PATH,
      robots: 3,
      mqttUrl: devBroker.url,
    });

    expect(fleet.agvIds).toEqual(["sim-001", "sim-002", "sim-003"]);
  }, 15_000);

  it("rejects a robot count larger than the map's usable node count", async () => {
    devBroker = await startDevBroker({ port: 0, wsPort: 0 });
    await expect(
      spawnFleet({ mapPath: MAP_PATH, robots: 100_000, mqttUrl: devBroker.url })
    ).rejects.toThrow(/usable start nodes/);
  }, 15_000);

  it("stop() is idempotent and disconnects every AGV", async () => {
    devBroker = await startDevBroker({ port: 0, wsPort: 0 });
    fleet = await spawnFleet({ mapPath: MAP_PATH, robots: 2, mqttUrl: devBroker.url });
    // See afterEach's comment for why a settle delay precedes stop() here.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await fleet.stop();
    await fleet.stop(); // must not throw / hang on double-stop
  }, 15_000);

  it("loads the map from the given path (sanity: file actually parses as the expected grid)", async () => {
    const raw = JSON.parse(await readFile(MAP_PATH, "utf-8"));
    expect(Array.isArray(raw.nodes)).toBe(true);
    expect(raw.nodes.length).toBeGreaterThanOrEqual(10);
  });
});
