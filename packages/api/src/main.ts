import { createPgDriver, createPgliteDriver, createRepos, migrate, type Repos } from "@tez/persistence";
import { loadConfig, type ApiConfig } from "./config.js";
import { buildSystem } from "./system.js";
import { buildServer } from "./server.js";
import { startRecorder, type Recorder } from "./recorder.js";

interface Persistence {
  repos: Repos;
  /** Closes the underlying driver (pg pool / pglite connection) — callers must invoke this on shutdown so buffered/disk-backed writes get flushed. */
  close(): Promise<void>;
}

/**
 * Builds persistence (repos + a close() to release the driver) per config,
 * if configured: `databaseUrl` takes precedence (real Postgres via
 * `createPgDriver`); otherwise `pgliteDir` (embedded pglite, possibly
 * on-disk); otherwise persistence is disabled (undefined) and the api runs
 * in-memory-only, as it did before Task 8. migrate() always runs before
 * repos are handed out, so callers never see an un-migrated schema.
 */
async function buildPersistence(config: ApiConfig): Promise<Persistence | undefined> {
  if (config.databaseUrl) {
    const driver = createPgDriver(config.databaseUrl);
    await migrate(driver);
    return { repos: createRepos(driver), close: () => driver.close() };
  }
  if (config.pgliteDir) {
    const driver = await createPgliteDriver(config.pgliteDir);
    await migrate(driver);
    return { repos: createRepos(driver), close: () => driver.close() };
  }
  return undefined;
}

/**
 * Production entrypoint: composes config -> system -> server, starts the
 * system's tick loop, binds a listener, and wires SIGINT/SIGTERM to a
 * graceful shutdown (stop accepting connections, then stop the recorder and
 * the orchestrator/adapter so nothing is left running in the background).
 */
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const system = await buildSystem(config);
  // scripts/demo.mjs's --vda mode scans api stdout for this exact
  // `BROKER_URL=<url>` pattern to discover the (possibly dev-broker-
  // assigned) broker url instead of falling back to its hardcoded default
  // after a 5s grace period (see docs/superpowers/specs/2026-08-11-cleanup-
  // wave-design.md decision 4).
  if (system.mode === "vda" && system.mqttUrl) {
    console.log(`BROKER_URL=${system.mqttUrl}`);
  }
  await system.start();

  const persistence = await buildPersistence(config);
  const recorder: Recorder | undefined = persistence
    ? startRecorder(system, persistence.repos)
    : undefined;

  const app = await buildServer(system, { config, repos: persistence?.repos });
  await app.listen({ port: config.port, host: "0.0.0.0" });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`received ${signal}, shutting down`);
    Promise.resolve()
      .then(async () => {
        // recorder.stop() only clears its poll timer — it does not await any
        // writes already in flight (all repo writes are fire-and-forget, see
        // recorder.ts), so a handful of in-flight writes may still be
        // pending when close() runs below. Acceptable for v1: those writes
        // are typically sub-millisecond against pglite/pg, so in practice
        // they settle well before close()/process.exit() actually run.
        recorder?.stop();
        await app.close();
        await system.stop();
        await persistence?.close();
      })
      .then(
        () => process.exit(0),
        (err: unknown) => {
          app.log.error(err);
          process.exit(1);
        }
      );
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
