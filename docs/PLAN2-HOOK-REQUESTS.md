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

## 2. Order-lifecycle event hook on `Orchestrator`

**Needed by:** `packages/api/src/recorder.ts`'s order-history mirroring
(`repos.orders.appendHistory`, diffing `snap.orders` status against a local
`Map<orderId, status>` on a fixed 1s poll).

**Why:** The recorder has no push/event API into the orchestrator, so it
diffs `orchestrator.snapshot()` on a 1s poll (the accepted v1 workaround
recorded in this file's header) to detect order status transitions and
append them to `transport_order_history`. Polling can only ever observe the
status an order happens to be in *at each poll tick* — any transitions that
happen and complete entirely within a single 1s window are invisible to the
diff. In practice this means a fast `queued → dispatched → underway` (or
`underway → completed`) sequence can collapse into a single observed jump
(e.g. straight `queued → underway`), silently dropping intermediate rows
from the DB audit trail. This is a structural limitation of polling, not a
recorder bug — no poll interval short of "every tick" fully closes it, and
tightening `POLL_MS` only narrows the window, it doesn't eliminate it.

**Requested public API:** an event-emitter or callback hook on
`Orchestrator`, e.g.:

```ts
class Orchestrator {
  /** Fires once per order status transition, in order, as they happen — not sampled by any external poll cadence. */
  onOrderTransition(cb: (order: TransportOrder, from: string, to: string) => void): () => void; // returns unsubscribe
}
```

**v1 workaround:** none beyond the existing 1s `snapshot()` poll in
`recorder.ts` — accepted as a known audit-trail gap (see `docs/BACKLOG.md`
for how this is tracked going forward); `transport_order_history` should be
read as "best-effort, poll-sampled," not a complete transition log.
