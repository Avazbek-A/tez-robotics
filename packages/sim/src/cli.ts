#!/usr/bin/env node
import type { VdaVersion } from "vda-5050-lib";
import { spawnFleet, type FailRobotSpec } from "./fleet.js";

const VALID_VDA_VERSIONS: ReadonlySet<string> = new Set(["1.1.0", "2.0.0", "2.1.0", "3.0.0"]);

export interface CliArgs {
  map: string;
  robots: number;
  broker: string;
  interfaceName?: string;
  vdaVersion?: VdaVersion;
  failRobot: FailRobotSpec[];
}

function requireValue(argv: string[], i: number, flag: string): string {
  const value = argv[i];
  if (value === undefined) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag} must be a positive integer, got "${raw}"`);
  }
  return n;
}

function parseFailRobot(raw: string): FailRobotSpec {
  const at = raw.lastIndexOf("@");
  if (at <= 0 || at === raw.length - 1) {
    throw new Error(`--fail-robot must be formatted <id>@<sec>, got "${raw}"`);
  }
  const id = raw.slice(0, at);
  const atSecRaw = raw.slice(at + 1);
  const atSec = Number(atSecRaw);
  if (!Number.isFinite(atSec) || atSec < 0) {
    throw new Error(`--fail-robot seconds must be a non-negative number, got "${atSecRaw}"`);
  }
  return { id, atSec };
}

/** Hand-parsed CLI args — no yargs/commander dependency, per task constraints. */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    map: "",
    robots: 0,
    broker: "mqtt://localhost:1883",
    failRobot: [],
  };
  let sawMap = false;
  let sawRobots = false;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--map":
        args.map = requireValue(argv, ++i, "--map");
        sawMap = true;
        break;
      case "--robots":
        args.robots = parsePositiveInt(requireValue(argv, ++i, "--robots"), "--robots");
        sawRobots = true;
        break;
      case "--broker":
        args.broker = requireValue(argv, ++i, "--broker");
        break;
      case "--interface-name":
        args.interfaceName = requireValue(argv, ++i, "--interface-name");
        break;
      case "--vda-version": {
        const v = requireValue(argv, ++i, "--vda-version");
        if (!VALID_VDA_VERSIONS.has(v)) {
          throw new Error(`--vda-version must be one of ${[...VALID_VDA_VERSIONS].join(", ")}, got "${v}"`);
        }
        args.vdaVersion = v as VdaVersion;
        break;
      }
      case "--fail-robot":
        args.failRobot.push(parseFailRobot(requireValue(argv, ++i, "--fail-robot")));
        break;
      default:
        throw new Error(`unknown argument: "${flag}"`);
    }
  }

  if (!sawMap) throw new Error("--map is required");
  if (!sawRobots) throw new Error("--robots is required");
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // eslint-disable-next-line no-console
  console.log(
    `[sim] spawning ${args.robots} robot(s) from ${args.map} against ${args.broker}` +
      (args.failRobot.length > 0
        ? ` (failure injection: ${args.failRobot.map((f) => `${f.id}@${f.atSec}s`).join(", ")})`
        : "")
  );

  const fleet = await spawnFleet({
    mapPath: args.map,
    robots: args.robots,
    mqttUrl: args.broker,
    interfaceName: args.interfaceName,
    vdaVersion: args.vdaVersion,
    failRobot: args.failRobot,
  });

  // eslint-disable-next-line no-console
  console.log(`[sim] fleet online: ${fleet.agvIds.join(", ")}`);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`[sim] received ${signal}, shutting down fleet...`);
    fleet
      .stop()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error("[sim] error during shutdown:", err);
        process.exit(1);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Only auto-run when executed directly (`node dist/cli.js ...`), not when
// imported by tests for `parseArgs()` coverage.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error("[sim] fatal:", err);
    process.exit(1);
  });
}
