import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import type { Repos } from "@tez/persistence";
import type { System } from "../system.js";

export interface OrdersRouteOpts extends FastifyPluginOptions {
  system: System;
  /**
   * Optional (Task 8). When present and `?history=1` is passed to
   * GET /orders, each order's `history` field is replaced with DB rows
   * (see `DbHistoryEntrySchema`) instead of the in-memory
   * `InMemoryHistoryEntrySchema` entries — hence `history`'s item schema
   * below is a union of both real shapes.
   */
  repos?: Repos;
}

const OrderStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("dispatched"),
  Type.Literal("underway"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("canceled"),
]);

/** In-memory `TransportOrder.history` entry shape (@tez/core's OrderBook). */
const InMemoryHistoryEntrySchema = Type.Object({
  at: Type.String(),
  from: OrderStatusSchema,
  to: OrderStatusSchema,
  reason: Type.Optional(Type.String()),
});

/**
 * `transport_order_history` row shape, as returned by
 * `Repos.orders.history()` (see packages/persistence/src/repos.ts). `id` is
 * a bigserial: pglite returns it as `number`, node-postgres returns int8
 * columns as `string` by default — both are accepted. `robot_id`/`note` are
 * nullable columns, returned as `null` (not `undefined`) when unset.
 */
const DbHistoryEntrySchema = Type.Object({
  id: Type.Union([Type.String(), Type.Number()]),
  order_id: Type.String(),
  at: Type.String(),
  status: OrderStatusSchema,
  robot_id: Type.Union([Type.String(), Type.Null()]),
  note: Type.Union([Type.String(), Type.Null()]),
});

export const TransportOrderSchema = Type.Object({
  id: Type.String(),
  pickupNode: Type.String(),
  dropNode: Type.String(),
  status: OrderStatusSchema,
  robotId: Type.Optional(Type.String()),
  retries: Type.Number(),
  createdAt: Type.String(),
  history: Type.Array(Type.Union([InMemoryHistoryEntrySchema, DbHistoryEntrySchema])),
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
const OrdersListQuery = Type.Object({
  history: Type.Optional(Type.String()),
});
type OrdersListQuery = Static<typeof OrdersListQuery>;

export async function ordersRoutes(app: FastifyInstance, opts: OrdersRouteOpts): Promise<void> {
  const { system, repos } = opts;

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

  app.get<{ Querystring: OrdersListQuery }>(
    "/orders",
    {
      schema: {
        querystring: OrdersListQuery,
        response: {
          200: OrdersListResponse,
        },
      },
    },
    async (request) => {
      const { orders } = system.orchestrator.snapshot();
      // history=1 without repos: in-memory TransportOrder.history is already
      // in the payload, so there's nothing more to attach — return as-is.
      if (request.query.history !== "1" || !repos) {
        return { orders };
      }
      const withDbHistory = await Promise.all(
        orders.map(async (order) => ({
          ...order,
          history: await repos.orders.history(order.id),
        }))
      );
      return { orders: withDbHistory };
    }
  );

  // Wired to Orchestrator.cancelOrder (see docs/PLAN2-HOOK-REQUESTS.md
  // entry 1 — the hook it requested, now implemented). cancelOrder throws
  // "order not found: ..." for an unknown id and "order already terminal:
  // ..." for a terminal one; mapped to 404/409 by message prefix below.
  app.delete<{ Params: OrderIdParams }>(
    "/orders/:id",
    {
      schema: {
        params: OrderIdParams,
        response: {
          200: TransportOrderSchema,
          404: ErrorResponse,
          409: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        return system.orchestrator.cancelOrder(request.params.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith("order not found: ")) {
          reply.code(404);
          return { error: message };
        }
        if (message.startsWith("order already terminal: ")) {
          reply.code(409);
          return { error: message };
        }
        throw err;
      }
    }
  );
}
