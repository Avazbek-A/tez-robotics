import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { Type } from "@sinclair/typebox";
import type { System } from "../system.js";

export interface HealthRouteOpts extends FastifyPluginOptions {
  system: System;
}

const HealthResponse = Type.Object({
  status: Type.Literal("ok"),
  mode: Type.Union([Type.Literal("demo"), Type.Literal("vda")]),
  robotsOnline: Type.Number(),
  degraded: Type.Literal(false),
});

/**
 * Fastify plugin registering /health. v1: "online" is approximated as
 * "not UNKNOWN" — the orchestrator sets a robot's status to UNKNOWN only
 * once it has been offline beyond the offline-grace period (see
 * Orchestrator.handleOfflineTimeouts), so this is the only signal snapshot()
 * currently exposes for connectivity. `degraded` is hardcoded false in v1
 * (no alarm-derived degradation policy yet — getAlarms() exists but nothing
 * here consumes it).
 */
export async function healthRoutes(app: FastifyInstance, opts: HealthRouteOpts): Promise<void> {
  const { system } = opts;

  app.get(
    "/health",
    {
      schema: {
        response: {
          200: HealthResponse,
        },
      },
    },
    async () => {
      const { robots } = system.orchestrator.snapshot();
      const robotsOnline = robots.filter((r) => r.status !== "UNKNOWN").length;
      return {
        status: "ok" as const,
        mode: system.mode,
        robotsOnline,
        degraded: false as const,
      };
    }
  );
}
