import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { writeFileSync } from "node:fs";
import { Type } from "@sinclair/typebox";
import { WarehouseMap } from "@tez/core";
import type { System } from "../system.js";

export interface MapRouteOpts extends FastifyPluginOptions {
  system: System;
  /**
   * PUT /map's write target. Mirrors config.mapFile ?? "map.json" — resolved
   * relative to cwd when unset, matching how system.ts falls back to the
   * bundled demo map when config.mapFile is absent.
   */
  mapFile?: string;
}

const ErrorResponse = Type.Object({
  error: Type.String(),
});

const PutMapResponse = Type.Object({
  ok: Type.Literal(true),
  restartRequired: Type.Literal(true),
});

/**
 * Fastify plugin registering GET/PUT /map.
 *
 * GET returns `system.mapJson` verbatim — the raw {nodes, edges} data the
 * running system booted with, not the parsed WarehouseMap.
 *
 * PUT validates the request body via WarehouseMap.fromJSON (structural
 * checks: nodes/edges arrays, no orphan edges) and, on success, writes it
 * to disk so the *next* boot picks it up. Swapping the map into the
 * already-running orchestrator would require rebuilding its routing state
 * mid-flight — out of v1 scope — so the response honestly flags
 * restartRequired instead of pretending the swap is live.
 */
export async function mapRoutes(app: FastifyInstance, opts: MapRouteOpts): Promise<void> {
  const { system, mapFile } = opts;
  const targetFile = mapFile ?? "map.json";

  app.get(
    "/map",
    {
      schema: {
        description: "Raw {nodes, edges} map data the system booted with.",
      },
    },
    async () => system.mapJson
  );

  app.put(
    "/map",
    {
      schema: {
        description:
          "Validate a new map and persist it to disk for the next boot (does not hot-swap the running orchestrator).",
        response: {
          200: PutMapResponse,
          400: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        WarehouseMap.fromJSON(request.body);
      } catch (err) {
        reply.code(400);
        return { error: err instanceof Error ? err.message : String(err) };
      }

      writeFileSync(targetFile, JSON.stringify(request.body, null, 2));
      return { ok: true as const, restartRequired: true as const };
    }
  );
}
