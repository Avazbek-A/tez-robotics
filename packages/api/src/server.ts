import Fastify, { type FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { Repos } from "@tez/persistence";
import type { System } from "./system.js";
import type { ApiConfig } from "./config.js";
import { ordersRoutes } from "./routes/orders.js";
import { robotsRoutes } from "./routes/robots.js";
import { healthRoutes } from "./routes/health.js";
import { mapRoutes } from "./routes/map.js";
import { kpiRoutes } from "./routes/kpi.js";
import { wsRoutes } from "./ws.js";

export interface BuildServerOpts {
  /**
   * Optional persistence repos (Task 8). When present, GET /orders?history=1
   * gains DB-backed history and GET /kpi?from=&to= gains a persisted range.
   * Absent by default — the api is fully functional with no persistence
   * configured (in-memory history only, no kpi range).
   */
  repos?: Repos;
  /**
   * Supplies PUT /map's write target (config.mapFile). Optional so existing
   * callers that only care about system-level behavior (e.g. earlier tasks'
   * tests) don't need to thread a config through — PUT /map then falls back
   * to "map.json" under cwd, same default system.ts uses when reading.
   */
  config?: ApiConfig;
}

/**
 * Fastify app factory: registers the REST route plugins over `system`
 * (Task 2's composition root). No listen() call here — callers (tests via
 * `fastify.inject`, or a production entrypoint) own binding to a port.
 */
export async function buildServer(system: System, opts?: BuildServerOpts): Promise<FastifyInstance> {
  const app = Fastify();

  await app.register(swagger, {
    openapi: {
      info: { title: "Tez Robotics API", version: "0.0.1" },
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

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

  await app.register(ordersRoutes, { system, repos: opts?.repos });
  await app.register(robotsRoutes, { system });
  await app.register(healthRoutes, { system });
  await app.register(mapRoutes, { system, mapFile: opts?.config?.mapFile });
  await app.register(kpiRoutes, { system, repos: opts?.repos });
  await app.register(wsRoutes, { system });

  return app;
}
