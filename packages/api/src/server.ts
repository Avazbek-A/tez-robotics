import Fastify, { type FastifyInstance } from "fastify";
import type { System } from "./system.js";
import { ordersRoutes } from "./routes/orders.js";
import { robotsRoutes } from "./routes/robots.js";
import { healthRoutes } from "./routes/health.js";

export interface BuildServerOpts {
  /**
   * Placeholder for Task 8's persistence layer — unused until then.
   * Typed as a plain `object` (not yet a concrete `Persistence` interface)
   * so this signature doesn't need to change when Task 8 lands.
   */
  persistence?: object;
}

/**
 * Fastify app factory: registers the REST route plugins over `system`
 * (Task 2's composition root). No listen() call here — callers (tests via
 * `fastify.inject`, or a production entrypoint) own binding to a port.
 */
export async function buildServer(system: System, opts?: BuildServerOpts): Promise<FastifyInstance> {
  void opts; // persistence placeholder unused until Task 8

  const app = Fastify();

  await app.register(ordersRoutes, { system });
  await app.register(robotsRoutes, { system });
  await app.register(healthRoutes, { system });

  return app;
}
