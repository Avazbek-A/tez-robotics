# Plan 2 — Hook Requests

Needs discovered while building `packages/api` on top of the existing,
not-to-be-edited `@tez/orchestrator` / `@tez/core` public APIs (see
`docs/HANDOFF-plan2-dashboard.md`). Each entry: the missing hook, why it's
needed, and the v1 workaround shipped instead.

## 1. `cancelOrder(orderId)` on `Orchestrator`

**Needed by:** `DELETE /orders/:id` (`packages/api/src/routes/orders.ts`).

**Why:** Cancelling an order requires transitioning it to `canceled` in the
order book (`OrderBook.transition(id, "canceled", reason)` already supports
this transition from any non-terminal state) and, if it's already assigned to
a robot, releasing that robot's leg/reservations and telling the adapter to
cancel the in-flight mission. `OrderBook` is a private field of
`Orchestrator` (`packages/orchestrator/src/orchestrator.ts`) — there is no
public method that exposes cancellation, and the API package must not reach
into orchestrator internals or edit orchestrator source.

**Requested public method:**

```ts
class Orchestrator {
  /**
   * Cancels an order: any non-terminal order → canceled. If a robot
   * currently holds it, cancels that robot's in-flight mission
   * (best-effort, same as existing offline/failure paths), releases its
   * reservations, and clears its leg so it re-enters the idle pool.
   * @throws if the order is not found or already terminal.
   */
  cancelOrder(orderId: string): TransportOrder;
}
```

**v1 workaround:** `DELETE /orders/:id` returns `501 Not Implemented` with
`{"error": "cancel not supported: orchestrator exposes no cancel API (see docs/PLAN2-HOOK-REQUESTS.md)"}`.
