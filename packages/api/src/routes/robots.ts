import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { Type } from "@sinclair/typebox";
import type { System } from "../system.js";

export interface RobotsRouteOpts extends FastifyPluginOptions {
  system: System;
}

const RobotStatusSchema = Type.Union([
  Type.Literal("IDLE"),
  Type.Literal("EXECUTING"),
  Type.Literal("CHARGING"),
  Type.Literal("ERROR"),
  Type.Literal("UNKNOWN"),
]);

export const RobotStateSchema = Type.Object({
  id: Type.String(),
  pos: Type.Object({ x: Type.Number(), y: Type.Number() }),
  theta: Type.Number(),
  battery: Type.Number(),
  status: RobotStatusSchema,
  currentMissionId: Type.Optional(Type.String()),
  lastSeen: Type.String(),
});

const RobotsListResponse = Type.Object({
  robots: Type.Array(RobotStateSchema),
});

/** Fastify plugin registering /robots routes. Reads via system.orchestrator.snapshot(). */
export async function robotsRoutes(app: FastifyInstance, opts: RobotsRouteOpts): Promise<void> {
  const { system } = opts;

  app.get(
    "/robots",
    {
      schema: {
        response: {
          200: RobotsListResponse,
        },
      },
    },
    async () => {
      const { robots } = system.orchestrator.snapshot();
      return { robots };
    }
  );
}
