#!/usr/bin/env node
// Task 12: one-command demo. `pnpm demo` (FakeAdapter, the filming path) or
// `pnpm demo:vda` (dev MQTT broker + a real virtual AGV fleet — best-effort,
// see the --vda section below and task-12-report.md).
//
// Builds @tez/api, spawns it, waits for /health, spawns the dashboard dev
// server, seeds a handful of demo orders on a stagger, and prints the URL.
// SIGINT/SIGTERM tear down both children.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VDA = process.argv.includes("--vda");
const FILM = process.argv.includes("--film");
const API_PORT = 8080;
const DASHBOARD_PORT = 5173;
const ORDER_COUNT = 6;
const ORDER_STAGGER_MS = 4000;

// --film: the President-Tech-Award recording configuration. Bigger floor
// (20x10 vs the default 8x8), a full 8-robot fleet (the demo-mode maximum,
// see DEMO_START_NODES in packages/api/src/demo-map.ts), and a continuous
// order generator that keeps the active queue topped up so the fleet never
// goes idle on camera. FakeAdapter lockstep only (--film + --vda is
// rejected): lockstep is the collision-clean path until BACKLOG P0 lands.
const FILM_GRID = { width: 20, height: 10 };
const FILM_ROBOTS = 8;
const FILM_TARGET_ACTIVE = 6; // keep this many orders in flight
const FILM_ORDER_INTERVAL_MS = 2500;
const FILM_MIN_MANHATTAN = 6; // short hops read as jitter on camera

// ---------------------------------------------------------------------------
// KNOWN ISSUE this script works around: `node packages/api/dist/main.js`
// (bare, after `tsc -p tsconfig.build.json`) fails at startup two different
// ways, neither fixable by editing packages/api itself (out of this task's
// edit scope — see task-12-brief.md's "Global constraints"):
//
// 1. Sibling workspace packages (@tez/core, @tez/orchestrator,
//    @tez/persistence, @tez/robot-interface, @tez/shared) all have
//    `"main": "src/index.ts"` in their package.json — none of them are
//    built. Plain `node` can't load a bare `.ts` import
//    (ERR_MODULE_NOT_FOUND). Fix: run the built api entrypoint through
//    `tsx`'s `--import` loader hook (added as a root devDependency, MIT
//    licensed — see root package.json), which transpiles any `.ts` file it
//    encounters on the fly, including these unbuilt workspace deps. This
//    was chosen over (a) a custom loader from scratch, (b) building every
//    workspace package (some, e.g. @tez/robot-interface, don't even have a
//    tsconfig.build.json), or (c) a vite-node-based runner (not a
//    dependency of this repo) — tsx is the smallest, most direct fix and
//    the api's own build step is kept (`tsc -p tsconfig.build.json` below)
//    as a real compile-correctness gate, even though tsx alone could also
//    run packages/api/src/main.ts directly without it.
//
// 2. Independent of (1): @tez/robot-interface's index.ts barrel-exports
//    `startDevBroker` (from dev-broker.ts) unconditionally, and
//    dev-broker.ts does `import { createBroker } from "aedes"` at module
//    top level. Node's native ESM loader derives a CJS module's *named*
//    exports via static analysis of that module's OWN
//    `module.exports`/`exports.*` assignments (the `cjs-module-lexer`
//    Node itself uses); aedes's actual export line is
//    `module.exports = Aedes.createBroker = Aedes` — a chained assignment
//    onto the exported function itself, not a `module.exports.createBroker
//    = ...` pattern the lexer recognizes. So `import { createBroker } from
//    "aedes"` throws `SyntaxError: The requested module 'aedes' does not
//    provide an export named 'createBroker'` under Node's native ESM
//    loader — verified this reproduces identically via plain `node -e
//    "import('aedes')"` (no tsx involved) from packages/robot-interface,
//    so it is NOT a build-state issue like (1); it would break a fully
//    built @tez/robot-interface dist just as much. Because the barrel
//    export makes this fire on ANY import from @tez/robot-interface
//    (including plain `FakeAdapter`, used unconditionally by DEMO mode —
//    not just `startDevBroker`), this blocks `demo` too, not only
//    `demo:vda`. Fix: a Node module customization hook (registered via
//    `node:module`'s `register()`) that intercepts the bare `"aedes"`
//    specifier and resolves it to a tiny synthetic ES module built with
//    plain CJS `require()` instead of a native `import` — `require()` just
//    does property access on the returned object (`mod.createBroker`), no
//    lexer/named-export ambiguity involved. See `aedesShimImportUrl()`
//    below. This is scoped to this script only (a `data:` URL passed via
//    `--import`, not a file anywhere in a package's source) and does
//    nothing to modules other than the literal `"aedes"` specifier.
// ---------------------------------------------------------------------------
function aedesShimImportUrl() {
  const hookSrc = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "aedes") {
    const parent = context.parentURL || "file:///";
    const source = [
      "import { createRequire } from 'node:module';",
      "const require = createRequire(" + JSON.stringify(parent) + ");",
      "const mod = require('aedes');",
      "export default mod;",
      "export const createBroker = mod.createBroker;",
    ].join("\\n");
    const url = "data:text/javascript," + encodeURIComponent(source);
    return { url, shortCircuit: true, format: "module" };
  }
  return nextResolve(specifier, context);
}
`;
  const preloadSrc = `import { register } from "node:module"; register(${JSON.stringify(
    "data:text/javascript," + encodeURIComponent(hookSrc),
  )}, import.meta.url);`;
  return "data:text/javascript," + encodeURIComponent(preloadSrc);
}

// Valid node ids on the demo 8x8 grid (`WarehouseMap.grid(8, 8)`, see
// packages/api/src/demo-map.ts) are `n{x}_{y}` for x,y in 0..7. Kept in
// sync by hand with packages/dashboard/src/components/TaskQueue.tsx's
// CURATED_PAIRS (this script is plain JS in the repo root, TaskQueue is a
// TS module inside the dashboard package — no natural shared-import path
// between the two, so the list is duplicated; documented in
// task-12-report.md).
const CURATED_PAIRS = [
  ["n1_1", "n6_1"],
  ["n1_6", "n6_6"],
  ["n2_2", "n5_5"],
  ["n3_1", "n1_3"],
  ["n6_3", "n3_6"],
  ["n1_1", "n6_6"],
  ["n4_1", "n1_4"],
  ["n6_2", "n2_6"],
];

// Mirrors WarehouseMap.grid(width, height) (packages/core/src/map.ts) —
// same node ids `n{x}_{y}` (0-indexed), same 4-neighbor bidirectional
// edges, chargers along the x=0 column. Duplicated here for the same
// reason as CURATED_PAIRS: plain-JS root script, no import path into the
// TS packages.
function gridMapJson(width, height) {
  const nodes = [];
  const edges = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      nodes.push({ id: `n${x}_${y}`, pos: { x, y }, ...(x === 0 ? { charger: true } : {}) });
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const id = `n${x}_${y}`;
      if (x + 1 < width) edges.push({ from: id, to: `n${x + 1}_${y}`, bidirectional: true });
      if (y + 1 < height) edges.push({ from: id, to: `n${x}_${y + 1}`, bidirectional: true });
    }
  }
  return { nodes, edges };
}

// Continuous order stream for --film: tops the active queue back up to
// FILM_TARGET_ACTIVE whenever completions drain it. Random pickup/drop
// pairs, charger column (x=0) excluded, minimum manhattan distance so
// every trip is a visible traversal. Runs until Ctrl-C.
async function filmOrderLoop(port, { width, height }) {
  const randNode = () => {
    const x = 1 + Math.floor(Math.random() * (width - 1));
    const y = Math.floor(Math.random() * height);
    return { x, y, id: `n${x}_${y}` };
  };
  console.log(
    `[film] continuous order stream: keeping ~${FILM_TARGET_ACTIVE} orders active, new order every ${FILM_ORDER_INTERVAL_MS / 1000}s when below target`,
  );
  while (!shuttingDown) {
    try {
      const res = await fetch(`http://localhost:${port}/orders`);
      if (res.ok) {
        const { orders } = await res.json();
        const active = orders.filter((o) => ["queued", "dispatched", "underway"].includes(o.status)).length;
        if (active < FILM_TARGET_ACTIVE) {
          let a = randNode();
          let b = randNode();
          for (
            let tries = 0;
            (a.id === b.id || Math.abs(a.x - b.x) + Math.abs(a.y - b.y) < FILM_MIN_MANHATTAN) && tries < 20;
            tries++
          ) {
            b = randNode();
          }
          const post = await fetch(`http://localhost:${port}/orders`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pickupNode: a.id, dropNode: b.id }),
          });
          if (post.ok) {
            const order = await post.json();
            console.log(`[film] order ${order.id}: ${a.id} -> ${b.id} (${active + 1}/${FILM_TARGET_ACTIVE} active)`);
          } else {
            console.warn(`[film] order POST failed: HTTP ${post.status} ${await post.text()}`);
          }
        }
      }
    } catch (err) {
      if (!shuttingDown) console.warn("[film] order loop error:", err instanceof Error ? err.message : err);
    }
    await delay(FILM_ORDER_INTERVAL_MS);
  }
}

const children = [];
function track(child) {
  children.push(child);
  return child;
}

let shuttingDown = false;
function killAll(signal = "SIGINT") {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill(signal);
  }
}

process.on("SIGINT", () => {
  console.log("\n[demo] SIGINT received, shutting down...");
  killAll("SIGINT");
  setTimeout(() => process.exit(0), 500).unref();
});
process.on("SIGTERM", () => {
  killAll("SIGTERM");
  setTimeout(() => process.exit(0), 500).unref();
});

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

/** Spawns a child, tees its stdout to our own stdout, and returns {child, onLine} for scanning lines. */
function spawnTeeing(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"], ...opts });
  const lineListeners = [];
  let buf = "";
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      for (const fn of lineListeners) fn(line);
    }
  });
  return { child, onLine: (fn) => lineListeners.push(fn) };
}

async function waitForHealth(port, { timeoutMs = 30000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) return await res.json();
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await delay(intervalMs);
  }
  throw new Error(`api did not become healthy on :${port} within ${timeoutMs}ms (last error: ${lastErr?.message})`);
}

async function seedOrders(port, { count = ORDER_COUNT, staggerMs = ORDER_STAGGER_MS } = {}) {
  for (let i = 0; i < count; i++) {
    const [pickupNode, dropNode] = CURATED_PAIRS[i % CURATED_PAIRS.length];
    try {
      const res = await fetch(`http://localhost:${port}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pickupNode, dropNode }),
      });
      if (!res.ok) {
        const body = await res.text();
        console.warn(`[demo] seed order ${i + 1}/${count} failed: HTTP ${res.status} ${body}`);
      } else {
        const order = await res.json();
        console.log(`[demo] seeded order ${order.id}: ${pickupNode} -> ${dropNode}`);
      }
    } catch (err) {
      console.warn(`[demo] seed order ${i + 1}/${count} failed:`, err instanceof Error ? err.message : err);
    }
    if (i < count - 1) await delay(staggerMs);
  }
}

async function main() {
  if (FILM && VDA) {
    throw new Error("--film and --vda are mutually exclusive: filming uses FakeAdapter lockstep (see BACKLOG P0)");
  }

  console.log(`[demo] building @tez/api...`);
  await run("corepack", ["pnpm", "--filter", "@tez/api", "exec", "tsc", "-p", "tsconfig.build.json"]);

  const apiEnv = { ...process.env, PORT: String(API_PORT) };
  if (VDA) {
    apiEnv.DEV_BROKER = "1";
    delete apiEnv.DEMO;
  } else {
    apiEnv.DEMO = "1";
    apiEnv.PGLITE_DIR = apiEnv.PGLITE_DIR ?? "memory";
  }
  if (FILM) {
    const dir = await mkdtemp(path.join(tmpdir(), "tez-film-map-"));
    const mapPath = path.join(dir, "film-20x10.json");
    await writeFile(mapPath, JSON.stringify(gridMapJson(FILM_GRID.width, FILM_GRID.height)));
    apiEnv.MAP_FILE = mapPath;
    apiEnv.ROBOTS = String(FILM_ROBOTS);
    console.log(`[film] ${FILM_GRID.width}x${FILM_GRID.height} floor, ${FILM_ROBOTS} robots (map: ${mapPath})`);
  }

  console.log(`[demo] starting api (${VDA ? "vda + dev broker" : "demo/FakeAdapter"}) on :${API_PORT}...`);
  const { child: apiChild, onLine: onApiLine } = spawnTeeing(
    "node",
    // --conditions=development: Task 4 (build pipeline) gave every sibling
    // workspace package a conditional `exports` map — `development`
    // (source, what vitest/Vite request automatically outside production
    // mode) vs `default` (dist/, what a bare `node`/tsx process requests by
    // default with no flag). Without this flag, this tsx-spawned process
    // would resolve @tez/core, @tez/shared, @tez/orchestrator,
    // @tez/persistence, @tez/robot-interface through `default` -> dist/,
    // which (a) doesn't exist on a clean checkout until `pnpm build` has
    // been run (undocumented prerequisite, ERR_MODULE_NOT_FOUND) and (b)
    // once built, silently runs stale compiled output after any source
    // edit — exactly what decision 6's "dev keeps tsx/vitest on src" is
    // meant to prevent. This flag makes tsx's resolution match vitest's:
    // both now request `development` and land on source.
    ["--conditions=development", "--import", aedesShimImportUrl(), "--import", "tsx", "packages/api/dist/main.js"],
    { env: apiEnv },
  );
  track(apiChild);
  apiChild.on("exit", (code) => {
    if (!shuttingDown && code !== 0) {
      console.error(`[demo] api exited unexpectedly with code ${code}`);
    }
  });

  // VDA: register the BROKER_URL=<url> line listener HERE, synchronously,
  // right after spawnTeeing() — NOT after waitForHealth() below.
  // packages/api/src/main.ts logs that line immediately after buildSystem()
  // resolves, which is strictly BEFORE app.listen() — the same listen()
  // call /health (and therefore waitForHealth()) depends on. spawnTeeing's
  // stdout handler dispatches each line synchronously to whatever is in its
  // lineListeners array at that instant, with no buffering/replay for late
  // subscribers (see spawnTeeing above). So if this listener were attached
  // only after `await waitForHealth(...)`, the BROKER_URL line would
  // already have been dispatched to nobody and --vda would always fall
  // through to the 5s timeout/fallback below — silently wrong on any
  // non-default broker port. Attaching it here, before any further
  // `await`, guarantees it's in place before the child process's first
  // stdout data event can possibly fire (that requires at least one more
  // turn of the event loop than this synchronous code takes). The promise
  // itself is only awaited later, once mqttUrl is actually needed.
  let mqttUrlPromise;
  if (VDA) {
    mqttUrlPromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        console.warn(
          "[demo] no BROKER_URL=<url> line seen from the api within 5s; " +
            "assuming the dev broker's default mqtt://localhost:1883",
        );
        resolve("mqtt://localhost:1883");
      }, 5000);
      onApiLine((line) => {
        const match = line.match(/BROKER_URL=(\S+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
    });
  }

  console.log(`[demo] waiting for api /health...`);
  const health = await waitForHealth(API_PORT);
  console.log(`[demo] api healthy:`, health);

  if (VDA) {
    const mqttUrl = await mqttUrlPromise;

    console.log(`[demo] building @tez/sim (best-effort)...`);
    try {
      await run("corepack", ["pnpm", "--filter", "@tez/sim", "exec", "tsc", "-p", "tsconfig.build.json"]);
    } catch (err) {
      console.warn(`[demo] @tez/sim build failed, continuing (sim runs from source via tsx regardless):`, err.message);
    }

    console.log(`[demo] fetching the running map and spawning a 3-robot sim fleet against ${mqttUrl}...`);
    try {
      const mapRes = await fetch(`http://localhost:${API_PORT}/map`);
      if (!mapRes.ok) throw new Error(`GET /map failed: HTTP ${mapRes.status}`);
      const mapJson = await mapRes.json();
      const dir = await mkdtemp(path.join(tmpdir(), "tez-demo-map-"));
      const mapPath = path.join(dir, "map.json");
      await writeFile(mapPath, JSON.stringify(mapJson));

      // Import by relative file path (packages/sim/src/index.ts), not the
      // bare "@tez/sim" specifier: this pnpm workspace only symlinks a
      // package into a *dependent* package's own node_modules, and nothing
      // in the workspace declares @tez/sim as a dependency (it's the top
      // of the dependency chain, nothing imports it back) — so there is no
      // node_modules/@tez/sim anywhere for Node's bare-specifier resolution
      // to find, root included. A direct relative path sidesteps package
      // resolution entirely; tsx still transpiles the .ts source on load.
      const simIndexPath = path.join(ROOT, "packages", "sim", "src", "index.ts");
      const simScript = [
        `import { spawnFleet } from ${JSON.stringify(simIndexPath)};`,
        `const fleet = await spawnFleet(${JSON.stringify({ mapPath, robots: 3, mqttUrl })});`,
        "console.log('[demo] sim fleet online:', fleet.agvIds ?? fleet);",
      ].join("\n");

      const simChild = track(
        spawn(
          "node",
          // --conditions=development: same reasoning as the api spawn above
          // — this inline script imports packages/sim/src/index.ts directly
          // by path (see comment above simIndexPath), but that file itself
          // imports @tez/core and @tez/shared as bare specifiers, which
          // still go through package resolution and would otherwise land on
          // dist/ instead of src/.
          ["--conditions=development", "--import", "tsx", "--input-type=module", "-e", simScript],
          {
            cwd: ROOT,
            stdio: "inherit",
          },
        ),
      );
      simChild.on("exit", (code) => {
        if (!shuttingDown) {
          console.warn(`[demo] sim fleet process exited (code ${code}) — vda demo continues without it`);
        }
      });
    } catch (err) {
      console.warn(
        "[demo] could not start the sim fleet (best-effort, see BACKLOG.md #2 — bare-node dist for " +
          "workspace packages is a known gap):",
        err instanceof Error ? err.message : err,
      );
    }
  }

  console.log(`[demo] starting dashboard dev server on :${DASHBOARD_PORT}...`);
  track(
    spawn("corepack", ["pnpm", "--filter", "@tez/dashboard", "dev", "--port", String(DASHBOARD_PORT)], {
      cwd: ROOT,
      stdio: "inherit",
    }),
  );

  // Not required for correctness (the api is already up and orders POST
  // fine before the dashboard is ready), just avoids the first seeded
  // order's WS frame racing the dashboard's own boot in the terminal log.
  await delay(1500);

  if (FILM) {
    filmOrderLoop(API_PORT, FILM_GRID).catch((err) => console.error("[film] order loop failed:", err));
  } else if (!VDA) {
    console.log(`[demo] seeding ${ORDER_COUNT} demo orders (${ORDER_STAGGER_MS / 1000}s stagger)...`);
    seedOrders(API_PORT).catch((err) => console.error("[demo] seeding failed:", err));
  }

  console.log(`\n[demo] ready: http://localhost:${DASHBOARD_PORT}\n`);
}

main().catch((err) => {
  console.error("[demo] fatal:", err);
  killAll("SIGINT");
  process.exit(1);
});
