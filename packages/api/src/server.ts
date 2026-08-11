import Fastify, { type FastifyInstance } from "fastify";
import type { System } from "./system.js";
import { ordersRoutes } from "./routes/orders.js";
import { robotsRoutes } from "./routes/robots.js";
import { healthRoutes } from "./routes/health.js";
import { wsRoutes } from "./ws.js";

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

  // Normalize Typebox/AJV schema-validation failures (e.g. a missing
  // required body field) to the same {error: string} shape every route's
  // handler-thrown 400s already use (see routes/orders.ts's unknown-node
  // 400) — Fastify's default validation-error body is
  // {statusCode, code, error, message}, which doesn't match any declared
  // response schema and would otherwise leak that shape to clients. Other
  // (non-validation) errors fall through to Fastify's default handling.
  app.setErrorHandler((err, _request, reply) => {
    if (err.validation) {
      reply.code(400).send({ error: err.message });
      return;
    }
    reply.send(err);
  });

  await app.register(ordersRoutes, { system });
  await app.register(robotsRoutes, { system });
  await app.register(healthRoutes, { system });
  await app.register(wsRoutes, { system });

  return app;
}
