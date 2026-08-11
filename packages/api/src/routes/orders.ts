import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import type { System } from "../system.js";

export interface OrdersRouteOpts extends FastifyPluginOptions {
  system: System;
}

const OrderStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("dispatched"),
  Type.Literal("underway"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("canceled"),
]);

const HistoryEntrySchema = Type.Object({
  at: Type.String(),
  from: OrderStatusSchema,
  to: OrderStatusSchema,
  reason: Type.Optional(Type.String()),
});

export const TransportOrderSchema = Type.Object({
  id: Type.String(),
  pickupNode: Type.String(),
  dropNode: Type.String(),
  status: OrderStatusSchema,
  robotId: Type.Optional(Type.String()),
  retries: Type.Number(),
  createdAt: Type.String(),
  history: Type.Array(HistoryEntrySchema),
});

const CreateOrderBody = Type.Object({
  pickupNode: Type.String(),
  dropNode: Type.String(),
});
type CreateOrderBody = Static<typeof CreateOrderBody>;

const OrdersListResponse = Type.Object({
  orders: Type.Array(TransportOrderSchema),
});

const ErrorResponse = Type.Object({
  error: Type.String(),
});

const OrderIdParams = Type.Object({
  id: Type.String(),
});
type OrderIdParams = Static<typeof OrderIdParams>;

/**
 * Fastify plugin registering /orders routes. Consumes `system.orchestrator`
 * (Task 2's public API: submitOrder/snapshot) — never OrderBook directly,
 * which is private to the orchestrator package.
 */
export async function ordersRoutes(app: FastifyInstance, opts: OrdersRouteOpts): Promise<void> {
  const { system } = opts;

  app.post<{ Body: CreateOrderBody }>(
    "/orders",
    {
      schema: {
        body: CreateOrderBody,
        response: {
          201: TransportOrderSchema,
          400: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const { pickupNode, dropNode } = request.body;
      try {
        const order = system.orchestrator.submitOrder(pickupNode, dropNode);
        reply.code(201);
        return order;
      } catch (err) {
        reply.code(400);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  app.get(
    "/orders",
    {
      schema: {
        response: {
          200: OrdersListResponse,
        },
      },
    },
    async () => {
      const { orders } = system.orchestrator.snapshot();
      return { orders };
    }
  );

  // v1: no cancel API exists on Orchestrator (OrderBook is private to it).
  // See docs/PLAN2-HOOK-REQUESTS.md entry 1.
  app.delete<{ Params: OrderIdParams }>(
    "/orders/:id",
    {
      schema: {
        params: OrderIdParams,
        response: {
          501: ErrorResponse,
        },
      },
    },
    async (_request, reply) => {
      reply.code(501);
      return {
        error: "cancel not supported: orchestrator exposes no cancel API (see docs/PLAN2-HOOK-REQUESTS.md)",
      };
    }
  );
}
