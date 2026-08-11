import { loadConfig } from "./config.js";
import { buildSystem } from "./system.js";
import { buildServer } from "./server.js";

/**
 * Production entrypoint: composes config -> system -> server, starts the
 * system's tick loop, binds a listener, and wires SIGINT/SIGTERM to a
 * graceful shutdown (stop accepting connections, then stop the
 * orchestrator/adapter so nothing is left running in the background).
 */
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const system = await buildSystem(config);
  await system.start();

  const app = await buildServer(system, { config });
  await app.listen({ port: config.port, host: "0.0.0.0" });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`received ${signal}, shutting down`);
    Promise.resolve()
      .then(async () => {
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
