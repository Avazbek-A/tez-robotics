import { readFileSync } from "node:fs";
import { WarehouseMap } from "@tez/core";
import { Orchestrator } from "@tez/orchestrator";
import {
  FakeAdapter,
  Vda5050Adapter,
  startDevBroker,
  type DevBrokerResult,
} from "@tez/robot-interface";
import type { ApiConfig } from "./config.js";
import { DEMO_MAP, DEMO_START_NODES } from "./demo-map.js";

export interface System {
  orchestrator: Orchestrator;
  map: WarehouseMap;
  /** Raw {nodes,edges} map data, served verbatim by GET /map. */
  mapJson: unknown;
  mode: "demo" | "vda";
  /** demo: lockstep interval (adapter.tick() then tickOnce()); vda: orchestrator.start(). */
  start(): Promise<void>;
  /** Clears interval / stops orchestrator + closes dev broker. */
  stop(): Promise<void>;
}

function loadMapJson(config: ApiConfig): unknown {
  if (config.mapFile) {
    return JSON.parse(readFileSync(config.mapFile, "utf-8"));
  }
  return DEMO_MAP;
}

export async function buildSystem(config: ApiConfig): Promise<System> {
  const mapJson = loadMapJson(config);
  const map = WarehouseMap.fromJSON(mapJson);

  if (config.mode === "demo") {
    return buildDemoSystem(config, map, mapJson);
  }
  return buildVdaSystem(config, map, mapJson);
}

function buildDemoSystem(config: ApiConfig, map: WarehouseMap, mapJson: unknown): System {
  if (config.robots > DEMO_START_NODES.length) {
    throw new Error(
      `demo mode supports at most ${DEMO_START_NODES.length} robots (requested ${config.robots})`
    );
  }
  const initialRobots = Array.from({ length: config.robots }, (_, i) => ({
    id: `r${i + 1}`,
    startNodeId: DEMO_START_NODES[i]!,
  }));
  const fake = new FakeAdapter(initialRobots, map);
  const orchestrator = new Orchestrator(map, fake, { tickMs: config.tickMs });

  let timer: ReturnType<typeof setInterval> | undefined;

  return {
    orchestrator,
    map,
    mapJson,
    mode: "demo",
    async start() {
      if (timer) return;
      await fake.start();
      timer = setInterval(() => {
        fake.tick();
        orchestrator.tickOnce();
      }, config.tickMs);
    },
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      await fake.stop();
    },
  };
}

async function buildVdaSystem(config: ApiConfig, map: WarehouseMap, mapJson: unknown): Promise<System> {
  let devBroker: DevBrokerResult | undefined;
  // devBroker takes precedence over config.mqttUrl whenever config.devBroker is
  // true: a broker is always started in that case, and its url is used. In
  // practice loadConfig's fail-fast rule means valid configs only ever supply
  // one or the other, so this only matters if both happen to be set.
  let mqttUrl = config.mqttUrl;
  if (config.devBroker) {
    devBroker = await startDevBroker();
    mqttUrl = devBroker.url;
  }
  if (!mqttUrl) {
    // loadConfig already fail-fasts on this combination; kept as a defensive
    // guard against a config invariant drifting out of sync with this code.
    throw new Error("vda mode requires mqttUrl or devBroker");
  }

  const agvIds = Array.from({ length: config.robots }, (_, i) => ({
    manufacturer: "tez",
    serialNumber: `r${i + 1}`,
  }));
  const adapter = new Vda5050Adapter(agvIds, mqttUrl);
  const orchestrator = new Orchestrator(map, adapter, { tickMs: config.tickMs });

  return {
    orchestrator,
    map,
    mapJson,
    mode: "vda",
    async start() {
      await orchestrator.start();
    },
    async stop() {
      await orchestrator.stop();
      if (devBroker) {
        const broker = devBroker;
        devBroker = undefined;
        await broker.close();
      }
    },
  };
}
