import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { Type } from "@sinclair/typebox";
import type { System } from "../system.js";

export interface KpiRouteOpts extends FastifyPluginOptions {
  system: System;
}

const KpiSchema = Type.Object({
  ordersPerHour: Type.Number(),
  avgCycleMs: Type.Number(),
  utilization: Type.Number(),
});

const KpiResponse = Type.Object({
  live: KpiSchema,
});

/**
 * Fastify plugin registering GET /kpi. v1 exposes only the orchestrator's
 * in-memory `live` snapshot (system.orchestrator.snapshot().kpis); a
 * persisted-history `range` query param is added in Task 8, at which point
 * this response gains a sibling field alongside `live`.
 */
export async function kpiRoutes(app: FastifyInstance, opts: KpiRouteOpts): Promise<void> {
  const { system } = opts;

  app.get(
    "/kpi",
    {
      schema: {
        response: {
          200: KpiResponse,
        },
      },
    },
    async () => {
      const { kpis } = system.orchestrator.snapshot();
      return { live: kpis };
    }
  );
}
