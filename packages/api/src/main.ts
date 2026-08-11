import { createPgDriver, createPgliteDriver, createRepos, migrate, type Repos } from "@tez/persistence";
import { loadConfig, type ApiConfig } from "./config.js";
import { buildSystem } from "./system.js";
import { buildServer } from "./server.js";
import { startRecorder, type Recorder } from "./recorder.js";

/**
 * Builds persistence (repos) per config, if configured: `databaseUrl` takes
 * precedence (real Postgres via `createPgDriver`); otherwise `pgliteDir`
 * (embedded pglite, possibly on-disk); otherwise persistence is disabled
 * (undefined) and the api runs in-memory-only, as it did before Task 8.
 * migrate() always runs before repos are handed out, so callers never see
 * an un-migrated schema.
 */
async function buildRepos(config: ApiConfig): Promise<Repos | undefined> {
  if (config.databaseUrl) {
    const driver = createPgDriver(config.databaseUrl);
    await migrate(driver);
    return createRepos(driver);
  }
  if (config.pgliteDir) {
    const driver = await createPgliteDriver(config.pgliteDir);
    await migrate(driver);
    return createRepos(driver);
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
  await system.start();

  const repos = await buildRepos(config);
  const recorder: Recorder | undefined = repos ? startRecorder(system, repos) : undefined;

  const app = await buildServer(system, { config, repos });
  await app.listen({ port: config.port, host: "0.0.0.0" });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`received ${signal}, shutting down`);
    Promise.resolve()
      .then(async () => {
        recorder?.stop();
        await app.close();
        await system.stop();
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
