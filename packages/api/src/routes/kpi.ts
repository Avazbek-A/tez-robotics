import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import type { Repos } from "@tez/persistence";
import type { System } from "../system.js";

export interface KpiRouteOpts extends FastifyPluginOptions {
  system: System;
  /** Optional (Task 8). Enables the persisted `range` query via ?from=&to=. */
  repos?: Repos;
}

const KpiSchema = Type.Object({
  ordersPerHour: Type.Number(),
  avgCycleMs: Type.Number(),
  utilization: Type.Number(),
});

const KpiQuery = Type.Object({
  from: Type.Optional(Type.String()),
  to: Type.Optional(Type.String()),
});
type KpiQuery = Static<typeof KpiQuery>;

const KpiResponse = Type.Object({
  live: KpiSchema,
  range: Type.Optional(Type.Union([Type.Array(Type.Unknown()), Type.Null()])),
  note: Type.Optional(Type.String()),
});

/**
 * Fastify plugin registering GET /kpi. Always returns the orchestrator's
 * in-memory `live` snapshot (system.orchestrator.snapshot().kpis). When
 * `?from=` is supplied it additionally attempts a persisted-history `range`:
 * with `repos` present, `range` is `snapshots.kpiRange(from, to)` (`to`
 * defaults to now); without `repos`, `range` is `null` with an explanatory
 * `note` — persistence just isn't configured, not an error.
 */
export async function kpiRoutes(app: FastifyInstance, opts: KpiRouteOpts): Promise<void> {
  const { system, repos } = opts;

  app.get<{ Querystring: KpiQuery }>(
    "/kpi",
    {
      schema: {
        querystring: KpiQuery,
        response: {
          200: KpiResponse,
        },
      },
    },
    async (request) => {
      const { kpis } = system.orchestrator.snapshot();
      const { from, to } = request.query;

      if (from === undefined) {
        return { live: kpis };
      }
      if (!repos) {
        return { live: kpis, range: null, note: "persistence disabled" };
      }

      const toIso = to ?? new Date().toISOString();
      const range = await repos.snapshots.kpiRange(from, toIso);
      return { live: kpis, range };
    }
  );
}
