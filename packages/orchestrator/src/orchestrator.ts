import type { WarehouseMap, Agent, TransportOrder } from "@tez/core";
import { PibtRouter, ReservationTable, OrderBook, dispatch } from "@tez/core";
import type { RobotId as CoreRobotId } from "@tez/core";
import type { RobotAdapter, AdapterEvent } from "@tez/robot-interface";
import type { RobotId, RobotState, CellKey } from "@tez/shared";
import { cellKey } from "@tez/shared";

export interface OrchestratorOpts {
  /** Timer interval for start()'s auto-tick loop. Default 500ms. */
  tickMs?: number;
  /**
   * Max committed-but-untraversed nodes ahead of the robot; extension
   * pauses at this depth until the robot catches up. Default 5.
   */
  horizon?: number;
  /** Grace period before an offline robot's order is requeued. Default 10000ms. */
  offlineGraceMs?: number;
  /**
   * Deadlock backstop: consecutive fully-blocked routing ticks (robot
   * caught up to its frontier but the reservation claim for the next cell
   * keeps failing) after which the leg's order is requeued. Default 20
   * (= 10s at the default 500ms tick).
   */
  blockedTicksLimit?: number;
  /** Injectable clock (ms epoch), for deterministic tests. Default Date.now. */
  now?: () => number;
}

interface RobotLeg {
  orderId: string;
  phase: "pick" | "drop";
  goalNode: string;
  missionId: string;
  nodeIds: string[];
  sent: boolean;
  /** Index into nodeIds of the robot's confirmed position on this path (monotonic). */
  progressIndex: number;
  /** Consecutive routing ticks the leg was extension-blocked by a failed claim. */
  blockedTicks: number;
}

interface RobotRuntime {
  state: RobotState;
  online: boolean;
  offlineSinceMs?: number;
  offlineHandled: boolean;
  quarantined: boolean;
  currentNodeId?: string;
  /**
   * Most recent VDA5050 `lastNodeId` reported via a `missionProgress`
   * event, persisted across ticks until it changes again (missionProgress
   * only fires ON CHANGE — see `Vda5050Adapter.handleState`). Tracked
   * independently of `currentNodeId`'s positional-snap derivation: used as
   * an authoritative secondary signal by `handleMissionDone`'s
   * frontier-race guard, since a same-tick positional snap can
   * occasionally still resolve to the PREVIOUS node even after the AGV
   * itself has already confirmed reaching the next one (see that guard's
   * doc comment).
   */
  lastVdaNodeId?: string;
  idleSinceTick?: number;
  leg?: RobotLeg;
}

function asCoreRobotId(id: RobotId): CoreRobotId {
  return id as CoreRobotId;
}

/**
 * Parses a mission id of the form `${orderId}:${leg}` back into its parts.
 * orderId itself never contains ":" (OrderBook mints ids like "ord-00001"),
 * so splitting on the last colon is unambiguous.
 */
function parseMissionId(missionId: string): { orderId: string; leg: "pick" | "drop" } | undefined {
  const idx = missionId.lastIndexOf(":");
  if (idx === -1) return undefined;
  const leg = missionId.slice(idx + 1);
  if (leg !== "pick" && leg !== "drop") return undefined;
  return { orderId: missionId.slice(0, idx), leg };
}

/**
 * The ONLY place `rt.leg` is allowed to be assigned (new leg started) or
 * cleared (leg aborted/completed) — every such site in this file must call
 * this instead of assigning `rt.leg` directly. It resets
 * `rt.lastVdaNodeId` on every transition.
 *
 * Why: `lastVdaNodeId` is written by `missionProgress` events and read by
 * `handleMissionDone`'s frontier-race guard as "has the robot reached the
 * CURRENT leg's goal". Without this reset, a value confirmed for a
 * PREVIOUS leg persists indefinitely (missionProgress only fires on
 * change, so nothing else would ever clear it) — if a later, unrelated
 * leg's goal node happens to coincide with (or was already passed en
 * route to) that old value, the guard would wrongly treat a genuinely
 * premature "done" for the NEW leg as legitimate, even though the robot
 * hasn't made any progress on it at all. Scoping `lastVdaNodeId` to reset
 * on every leg transition ensures the guard only ever sees confirmation
 * that's about the leg currently being evaluated.
 */
function setLeg(rt: RobotRuntime, leg: RobotLeg | undefined): void {
  rt.leg = leg;
  rt.lastVdaNodeId = undefined;
}

/**
 * Orchestrator: wires map + router + reservations + dispatcher + order book
 * + RobotAdapter into a tick loop.
 *
 * Pipeline per tick, see task-10-report.md for full design rationale:
 *   1. drain queued adapter events (robot registry, order lifecycle)
 *   2. resolve each robot's current map node; quarantine unresolvable ones;
 *      idle robots (no leg) claim their own parked cell
 *   3. requeue orders for robots offline beyond the grace period
 *   4. dispatch idle robots x queued orders (Hungarian)
 *   5. PIBT step over each legged robot's committed FRONTIER (not its true
 *      position) and each idle robot's true position; extend a leg's path
 *      only when it is within `opts.horizon` nodes of its frontier, and
 *      only ever commit an extension on a FULL reservation grant for the
 *      whole uncommitted window — the ReservationTable is the source of
 *      truth for committed cells, never advisory
 *
 * Collision invariant: unlike a v1 design that depended on lockstep
 * interleaving of adapter ticks and orchestrator ticks (PIBT computing
 * moves once per tick over every robot's TRUE, freshly-synced position),
 * the invariant here rests on the ReservationTable: no cell is ever double
 * -granted, and a leg only ever advances past a claim that fully succeeded.
 * This holds regardless of adapter cadence — a physical robot may lag its
 * commanded frontier by any amount up to `opts.horizon`, and reservations
 * (not lockstep) are what keep two robots' committed windows disjoint.
 *
 * Known accepted limitation (BACKLOG, not fixed here): a parked IDLE robot
 * sitting on the only path into an order's pickup/drop permanently owns
 * that cell but is never itself commanded to move out of the way — PIBT
 * only ever pushes it virtually, never dispatches an actual parking move.
 * Such an order blocks every extension attempt until the deadlock backstop
 * (`opts.blockedTicksLimit` consecutive fully-blocked ticks) requeues it;
 * after 3 requeues OrderBook fails it outright rather than ever routing
 * around the parked robot.
 */
export class Orchestrator {
  private readonly map: WarehouseMap;
  private readonly adapter: RobotAdapter;
  private readonly opts: Required<Omit<OrchestratorOpts, "now">> & { now?: () => number };
  private readonly router: PibtRouter;
  private readonly reservations: ReservationTable;
  private readonly book: OrderBook;
  private readonly posToNode: Map<CellKey, string>;
  private readonly robots = new Map<RobotId, RobotRuntime>();
  private readonly eventQueue: AdapterEvent[] = [];
  private readonly allOrders: TransportOrder[] = [];
  private readonly alarms: string[] = [];
  private readonly cycleTimes: number[] = [];
  private completions = 0;
  private tickCount = 0;
  private timer?: ReturnType<typeof setInterval>;
  private readonly startedAtMs: number;

  constructor(map: WarehouseMap, adapter: RobotAdapter, opts?: OrchestratorOpts) {
    this.map = map;
    this.adapter = adapter;
    this.opts = {
      tickMs: opts?.tickMs ?? 500,
      horizon: opts?.horizon ?? 5,
      offlineGraceMs: opts?.offlineGraceMs ?? 10_000,
      blockedTicksLimit: opts?.blockedTicksLimit ?? 20,
      now: opts?.now,
    };
    this.router = new PibtRouter(map);
    this.reservations = new ReservationTable();
    this.book = new OrderBook(() => new Date(this.nowMs()).toISOString());

    this.posToNode = new Map();
    for (const id of map.nodeIds) {
      this.posToNode.set(cellKey(map.node(id).pos), id);
    }

    this.startedAtMs = this.nowMs();
    adapter.on((e) => this.eventQueue.push(e));
  }

  private nowMs(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  async start(): Promise<void> {
    if (this.timer) return;
    await this.adapter.start();
    this.timer = setInterval(() => this.runTick(), this.opts.tickMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.adapter.stop();
  }

  /** Manual synchronous tick, no timer — test hook mirroring what start()'s interval calls. */
  tickOnce(): void {
    this.runTick();
  }

  /**
   * Validates both node ids against the map BEFORE creating the order.
   * Without this, an order referencing an unknown node reaches dispatch(),
   * gets assigned to a robot, and runRouting() -> map.distance()/map.node()
   * throws inside runTick()'s top-level try/catch — which only logs an
   * alarm and skips the rest of THAT tick. The bogus order stays queued
   * (never removed from the book) and re-triggers the same throw on every
   * subsequent tick, before runRouting() ever gets to move any OTHER
   * robot's leg forward — freezing the whole fleet forever. Rejecting here,
   * synchronously, back to the caller keeps a bad submission from ever
   * being able to reach the tick pipeline at all.
   */
  submitOrder(pickupNode: string, dropNode: string): TransportOrder {
    this.map.node(pickupNode);
    this.map.node(dropNode);
    const order = this.book.create(pickupNode, dropNode);
    this.allOrders.push(order);
    return order;
  }

  snapshot(): {
    robots: RobotState[];
    orders: TransportOrder[];
    kpis: { ordersPerHour: number; avgCycleMs: number; utilization: number };
  } {
    const robots = Array.from(this.robots.values()).map((rt) => rt.state);
    const executing = robots.filter((r) => r.status === "EXECUTING").length;
    const utilization = robots.length > 0 ? executing / robots.length : 0;

    const elapsedHours = Math.max((this.nowMs() - this.startedAtMs) / 3_600_000, 1 / 3600);
    const ordersPerHour = this.completions / elapsedHours;
    const avgCycleMs =
      this.cycleTimes.length > 0
        ? this.cycleTimes.reduce((a, b) => a + b, 0) / this.cycleTimes.length
        : 0;

    return {
      robots,
      orders: [...this.allOrders],
      kpis: { ordersPerHour, avgCycleMs, utilization },
    };
  }

  /** Test/debug hook: alarm log accumulated so far (contention, quarantine, offline, failures). */
  getAlarms(): string[] {
    return [...this.alarms];
  }

  // ---- tick pipeline -----------------------------------------------------

  private runTick(): void {
    // Top-level guard: this runs off a bare setInterval callback in
    // start(), so an uncaught exception here would otherwise be an
    // unhandled error that can crash the process. Log and skip the rest of
    // this tick rather than taking the whole fleet down; the next tick
    // gets a fresh chance.
    try {
      this.tickCount++;
      const events = this.eventQueue.splice(0, this.eventQueue.length);
      for (const ev of events) this.handleEvent(ev);

      this.resolveCurrentNodes();
      this.handleOfflineTimeouts();
      this.runDispatch();
      this.runRouting();
    } catch (err) {
      this.alarms.push(`t=${this.tickCount} tick threw: ${String(err)}`);
    }
  }

  private handleEvent(e: AdapterEvent): void {
    switch (e.type) {
      case "state": {
        let rt = this.robots.get(e.state.id);
        if (rt) {
          rt.state = e.state;
        } else {
          rt = {
            state: e.state,
            online: true,
            offlineHandled: false,
            quarantined: false,
          };
          this.robots.set(e.state.id, rt);
        }
        // Frontier-race fix: recompute this robot's known node INLINE,
        // immediately — not just once per tick at the very end via
        // resolveCurrentNodes(). Events in this tick's batch are handled
        // strictly in arrival order (see runTick()); resolveCurrentNodes()
        // only runs AFTER the whole batch is drained, so without this, a
        // missionDone landing later in the SAME batch (e.g. right after
        // the state event that shows the robot has reached its goal) would
        // still see whatever currentNodeId was left over from the END of
        // the PREVIOUS tick, misclassifying a genuinely on-time completion
        // as premature. See handleMissionDone's frontier-race guard.
        //
        // ALWAYS assign here, including `undefined` when the position is
        // unresolvable — do not leave a stale, previously-valid node id in
        // place. resolveCurrentNodes() treats an already-set
        // `currentNodeId` as "resolved this batch, don't re-derive" (see
        // its own doc comment); if we skipped the assignment here on an
        // unresolvable snap, a robot that resolved once and later drifts
        // off-grid would keep its old valid node forever and never get
        // quarantined.
        rt.currentNodeId = this.snapToNode(rt.state.pos);
        break;
      }
      case "connection": {
        const rt = this.robots.get(e.robotId);
        if (!rt) break; // no known state yet for this robot; ignore
        rt.online = e.online;
        if (e.online) {
          rt.offlineSinceMs = undefined;
          rt.offlineHandled = false;
        } else if (rt.offlineSinceMs === undefined) {
          rt.offlineSinceMs = this.nowMs();
        }
        break;
      }
      case "missionProgress": {
        const rt = this.robots.get(e.robotId);
        if (!rt) break; // no known state yet for this robot; ignore
        rt.lastVdaNodeId = e.lastNodeId;
        // Authoritative per VDA5050 protocol semantics: the AGV itself is
        // reporting it has reached this node. Apply to currentNodeId
        // immediately too (not just lastVdaNodeId) so any LATER event in
        // this same batch sees it — mirrors the "state" case above. Per
        // the RobotAdapter per-tick event-ordering contract, missionProgress
        // fires BEFORE its accompanying state event, so that later state
        // event's positional-snap recompute (above) may still run after
        // this and land on the same node (the common case) or, rarely,
        // lag behind it — which is exactly why lastVdaNodeId is ALSO kept
        // as an independent, never-overwritten-by-snap signal for
        // handleMissionDone's guard.
        rt.currentNodeId = e.lastNodeId;
        break;
      }
      case "missionDone":
        this.handleMissionDone(e.robotId, e.missionId);
        break;
      case "missionFailed":
        this.handleMissionFailed(e.robotId, e.missionId, e.reason);
        break;
    }
  }

  /**
   * Stale-reporter guard (C1): both missionDone and missionFailed must only
   * be allowed to drive an order's lifecycle when the reporting robot is
   * that order's CURRENT holder per the order book — not merely "some
   * robot that once had a mission with this id". Without this, a robot
   * that went offline mid-leg, had its order requeued and reassigned to a
   * different robot, and then revived and finished its now-orphaned
   * mission (cancelMission is only best-effort — it cannot actually reach
   * an unreachable robot) would drive the REPLACEMENT robot's order
   * through a lifecycle transition it never earned, corrupting
   * order.robotId and leaving the real assignee's leg permanently stuck.
   *
   * Returns the live order object when `robotId` is confirmed to be its
   * current holder and its id matches `orderId`; otherwise logs an alarm
   * and returns undefined.
   *
   * Round-2 fix: on mismatch, do NOT unconditionally cancel the reporting
   * robot's adapter mission or clear its `rt.leg`. A robot can legitimately
   * be reassigned to a brand-new order B after the order this stale report
   * names (A) was requeued away from it; at that point `rt.leg` correctly
   * points at B, and B's mission is live and unrelated. Blindly canceling
   * here would kill B's real mission and blindly clearing `rt.leg` would
   * strand the robot (it stops getting mission extensions from
   * `runRouting()`, yet `book.byRobot()` still shows it holding B, so
   * `runDispatch()`'s `!rt.leg` gate never re-admits it to the idle pool
   * either — permanently stuck). Only touch the robot's bookkeeping/adapter
   * state when its CURRENT leg is for the SAME order the stale report
   * names — i.e. our own tracking agrees this report might plausibly be
   * about what's live right now, so cleaning it up is safe. If `rt.leg` is
   * undefined or for a different order, there is nothing of this stale
   * report's to clean up: leave it alone.
   */
  private verifyReportingRobot(
    robotId: RobotId,
    rt: RobotRuntime,
    orderId: string,
    kind: "missionDone" | "missionFailed"
  ): TransportOrder | undefined {
    const activeOrder = this.book.byRobot(asCoreRobotId(robotId));
    if (activeOrder && activeOrder.id === orderId) {
      return activeOrder;
    }
    this.alarms.push(
      `t=${this.tickCount} stale ${kind} from robot ${robotId} for order ${orderId} — ` +
        `not its current order, ignoring (order not advanced)`
    );
    if (rt.leg?.orderId === orderId) {
      void this.adapter.cancelMission(robotId).catch(() => {
        /* best-effort; robot may be unreachable, which is exactly why this fired */
      });
      setLeg(rt, undefined);
    }
    return undefined;
  }

  private handleMissionDone(robotId: RobotId, missionId: string): void {
    const rt = this.robots.get(robotId);
    if (!rt) return;
    const parsed = parseMissionId(missionId);
    if (!parsed) return;
    const { orderId, leg } = parsed;

    const order = this.verifyReportingRobot(robotId, rt, orderId, "missionDone");
    if (!order) return;

    // I1: frontier-race guard. A real (non-lockstepped) adapter can
    // truthfully report the wire-level mission it most recently sent as
    // fully processed before this robot's LAST KNOWN node has actually
    // caught up to the leg's goal node — e.g. Vda5050Adapter only ever
    // releases one more base node per tick (see its sendMission doc
    // comment), so a fast-moving AGV can drain its currently-released path
    // and report the VDA order "done" before the orchestrator has
    // appended/sent the next extension. rt.currentNodeId is now kept
    // batch-fresh (updated inline by handleEvent's "state"/"missionProgress"
    // cases, not just once per tick at the end via resolveCurrentNodes() —
    // see that fix's comments there), so a same-batch goal-arrival state
    // event immediately followed by this missionDone is seen correctly.
    // As a second, independent signal, also accept `rt.lastVdaNodeId`
    // (from the most recent missionProgress event, persisted across
    // ticks) reaching the goal — the AGV's own reported lastNodeId is
    // authoritative and can occasionally be ahead of what a position snap
    // resolves to, regardless of update ordering within a batch.
    //
    // Only intercept when the CURRENT leg genuinely matches this missionId
    // (rt.leg.missionId === missionId) — if it doesn't match at all (no
    // leg, or a different leg/order entirely), that's the pre-existing
    // "stale report" case already handled below via book.transition()'s
    // own try/catch, and must NOT be touched here.
    if (rt.leg && rt.leg.missionId === missionId) {
      const reachedGoal = rt.currentNodeId === rt.leg.goalNode || rt.lastVdaNodeId === rt.leg.goalNode;
      if (!reachedGoal) {
        this.alarms.push(
          `t=${this.tickCount} premature missionDone from robot ${robotId} for order ${orderId} ` +
            `(leg=${leg}, at=${String(rt.currentNodeId)}, lastVdaNodeId=${String(rt.lastVdaNodeId)}, goal=${rt.leg.goalNode}) — cancelling and requeueing`
        );
        void this.adapter.cancelMission(robotId).catch(() => {
          /* best-effort; robot may be unreachable */
        });
        try {
          this.book.requeue(orderId, "premature missionDone (frontier race)");
        } catch {
          /* already terminal */
        }
        this.reservations.releaseAll(robotId);
        setLeg(rt, undefined);
        return;
      }
    }

    if (leg === "pick") {
      try {
        this.book.transition(orderId, "underway", "pickup complete");
      } catch {
        return; // stale/duplicate event for an order no longer in this state
      }
      setLeg(rt, {
        orderId,
        phase: "drop",
        goalNode: order.dropNode,
        missionId: `${orderId}:drop`,
        nodeIds: [], // seeded once this tick's current node is resolved
        sent: false,
        progressIndex: 0,
        blockedTicks: 0,
      });
    } else {
      try {
        this.book.transition(orderId, "completed", "drop complete");
      } catch {
        return;
      }
      const cycleMs = this.nowMs() - Date.parse(order.createdAt);
      this.cycleTimes.push(cycleMs);
      this.completions++;
      setLeg(rt, undefined);
    }
  }

  private handleMissionFailed(robotId: RobotId, missionId: string, reason: string): void {
    const rt = this.robots.get(robotId);
    if (!rt) return;
    const parsed = parseMissionId(missionId);
    if (!parsed) {
      // Can't even tell which order this was for; just stop this robot
      // driving anything further and log it.
      setLeg(rt, undefined);
      this.alarms.push(
        `t=${this.tickCount} missionFailed from robot ${robotId} with unparseable mission id "${missionId}": ${reason}`
      );
      return;
    }

    const order = this.verifyReportingRobot(robotId, rt, parsed.orderId, "missionFailed");
    if (!order) return;

    try {
      this.book.requeue(parsed.orderId, reason);
    } catch {
      // already terminal / stale — nothing to do
    }
    this.reservations.releaseAll(robotId);
    setLeg(rt, undefined);
    this.alarms.push(`t=${this.tickCount} mission failed for robot ${robotId}: ${reason}`);
  }

  /**
   * Per-tick fallback/quarantine pass. Batch-freshness fix: `rt.currentNodeId`
   * may already have been set THIS tick — or carried over unchanged from a
   * prior one, which is fine, that just means "no new information arrived"
   * — by inline event handling in `handleEvent`'s "state"/"missionProgress"
   * cases. This method must NOT blindly re-derive/overwrite it from
   * `rt.state.pos`: that positional snap can occasionally lag behind a
   * more authoritative `missionProgress`-derived value (see
   * `RobotRuntime.lastVdaNodeId`'s doc comment), and clobbering it here
   * would silently undo that fix for anything reading `currentNodeId`
   * afterward this tick (dispatch/routing). Only derive fresh when nothing
   * has resolved a node yet, or defensively if what's already there
   * somehow isn't a real map node — otherwise this is purely the
   * quarantine-transition/reservation/leg-seeding bookkeeping pass it
   * always was.
   */
  private resolveCurrentNodes(): void {
    for (const [id, rt] of this.robots) {
      let nodeId = rt.currentNodeId;
      if (nodeId !== undefined && !this.map.nodeIds.includes(nodeId)) {
        nodeId = undefined;
      }
      if (nodeId === undefined) {
        nodeId = this.snapToNode(rt.state.pos);
      }

      if (nodeId === undefined) {
        rt.currentNodeId = undefined;
        if (!rt.quarantined) {
          rt.quarantined = true;
          rt.state.status = "ERROR";
          this.alarms.push(
            `t=${this.tickCount} robot ${id} at unresolvable position ${cellKey(rt.state.pos)} — quarantined`
          );
          const order = this.book.byRobot(asCoreRobotId(id));
          if (order) {
            try {
              this.book.requeue(order.id, "robot position unresolved");
            } catch {
              /* already terminal */
            }
          }
          this.reservations.releaseAll(id);
          setLeg(rt, undefined);
          // Best-effort: stop it executing whatever stale mission it still
          // thinks it has, so it doesn't quietly finish that mission later
          // (feeding the same stale-report class of bug the stale-reporter
          // guard above handles) and so a reused mission id on
          // un-quarantine doesn't hit the adapter's non-prefix-extension
          // rejection.
          void this.adapter.cancelMission(id).catch(() => {
            /* best-effort; robot may be unreachable */
          });
        }
        continue;
      }

      if (rt.quarantined) {
        rt.quarantined = false;
        this.alarms.push(`t=${this.tickCount} robot ${id} position recovered, un-quarantined`);
        if (rt.state.status === "ERROR") rt.state.status = "IDLE";
      }

      rt.currentNodeId = nodeId;
      this.reservations.release(id, cellKey(this.map.node(nodeId).pos));
      if (!rt.leg) {
        // Idle robots always own the cell they are parked on, so no other
        // robot's committed window can ever be granted through them.
        this.reservations.claim(id, [cellKey(this.map.node(nodeId).pos)]);
      }
      if (rt.leg && rt.leg.nodeIds.length === 0) {
        rt.leg.nodeIds = [nodeId];
      }
    }
  }

  private snapToNode(pos: RobotState["pos"]): string | undefined {
    return this.posToNode.get(cellKey(pos));
  }

  private handleOfflineTimeouts(): void {
    const grace = this.opts.offlineGraceMs;
    for (const [id, rt] of this.robots) {
      if (rt.offlineSinceMs === undefined) continue;
      if (rt.offlineHandled) continue;
      if (this.nowMs() - rt.offlineSinceMs < grace) continue;

      rt.offlineHandled = true;
      rt.state.status = "UNKNOWN";
      const order = this.book.byRobot(asCoreRobotId(id));
      if (order) {
        try {
          this.book.requeue(order.id, "robot offline beyond grace period");
        } catch {
          /* already terminal */
        }
      }
      this.reservations.releaseAll(id);
      setLeg(rt, undefined);
      void this.adapter.cancelMission(id).catch(() => {
        /* best-effort; robot is unreachable anyway */
      });
      this.alarms.push(
        `t=${this.tickCount} robot ${id} offline > ${grace}ms — order requeued, mission cancelled`
      );
    }
  }

  private runDispatch(): void {
    const idle: { id: CoreRobotId; at: string; idleSince: number }[] = [];

    for (const [id, rt] of this.robots) {
      if (rt.quarantined || rt.currentNodeId === undefined) continue;
      // Gate on our OWN leg bookkeeping, not the adapter-reported status
      // string: the latter is event-driven and can be transiently stale in
      // the very tick a leg transitions or gets cleared (e.g. pick->drop,
      // or a mission failure), which would otherwise cause an immediate,
      // incorrect re-dispatch. rt.leg is authoritative because we are the
      // only writer of it. Adapter status is still used to exclude robots
      // in a known-bad physical state.
      const badStatus =
        rt.state.status === "ERROR" || rt.state.status === "CHARGING" || rt.state.status === "UNKNOWN";
      const isFreeIdle = !rt.leg && !badStatus && !this.book.byRobot(asCoreRobotId(id));
      if (!isFreeIdle) {
        rt.idleSinceTick = undefined;
        continue;
      }
      if (rt.idleSinceTick === undefined) rt.idleSinceTick = this.tickCount;
      idle.push({ id: asCoreRobotId(id), at: rt.currentNodeId, idleSince: this.tickCount - rt.idleSinceTick });
    }

    if (idle.length === 0) return;

    const pendingOrders = this.book
      .pending()
      .filter((o) => o.status === "queued")
      .map((o) => ({ id: o.id, pickupNode: o.pickupNode }));
    if (pendingOrders.length === 0) return;

    const assignments = dispatch(idle, pendingOrders, this.map);
    for (const a of assignments) {
      const order = this.book.assign(a.orderId, a.robotId);
      const rt = this.robots.get(a.robotId);
      if (!rt || rt.currentNodeId === undefined) continue;
      rt.idleSinceTick = undefined;
      setLeg(rt, {
        orderId: order.id,
        phase: "pick",
        goalNode: order.pickupNode,
        missionId: `${order.id}:pick`,
        nodeIds: [rt.currentNodeId],
        sent: false,
        progressIndex: 0,
        blockedTicks: 0,
      });
    }
  }

  /**
   * PIBT plans over each legged robot's committed FRONTIER (the last node
   * of its currently-sent path), not its true physical position — a
   * virtual configuration that plans ahead of the physical robots. This
   * keeps appended moves adjacent to the frontier by construction (no more
   * geometrically invalid paths from stitching a true-position move onto a
   * stale frontier), and the zero-collision guarantee no longer depends on
   * lockstep interleaving of adapter ticks and orchestrator ticks: it rests
   * on the ReservationTable, which is the source of truth for committed
   * cells and is checked (and only committed to on a full grant) on every
   * extension below, regardless of adapter cadence.
   *
   * Known accepted limitation (BACKLOG, not fixed here): a parked IDLE
   * robot sitting on the only path into an order's pickup/drop permanently
   * owns that cell (see resolveCurrentNodes()) but is never itself
   * commanded to move out of the way — PIBT only ever pushes it virtually.
   * Such an order blocks forever until the deadlock backstop below
   * requeues it, and after 3 requeues OrderBook fails it outright, rather
   * than ever being routed around the parked robot.
   */
  private runRouting(): void {
    const agents: Agent[] = [];
    for (const [id, rt] of this.robots) {
      if (rt.quarantined || rt.currentNodeId === undefined) continue;
      if (rt.leg && rt.leg.nodeIds.length > 0) {
        // Plan from the leg's commanded FRONTIER, not the robot's true
        // position: appended moves are then adjacent to the frontier by
        // construction, and the planned configuration stays internally
        // consistent even when physical robots lag behind their frontiers.
        const frontier = rt.leg.nodeIds[rt.leg.nodeIds.length - 1]!;
        agents.push({ id, at: frontier, goal: rt.leg.goalNode, priority: 0 });
      } else {
        agents.push({ id, at: rt.currentNodeId, goal: rt.currentNodeId, priority: 0 });
      }
    }
    if (agents.length === 0) return;

    const moves = this.router.step(agents);

    for (const [id, rt] of this.robots) {
      if (!rt.leg || rt.currentNodeId === undefined) continue;
      const leg = rt.leg;
      if (leg.nodeIds.length === 0) continue; // seeded next resolveCurrentNodes pass

      // Advance monotonic progress: first match of the robot's current
      // node at or after the previous progress index (paths may revisit
      // nodes; the robot traverses them in order, so never scan backward).
      for (let j = leg.progressIndex; j < leg.nodeIds.length; j++) {
        if (leg.nodeIds[j] === rt.currentNodeId) {
          if (j > leg.progressIndex) {
            leg.progressIndex = j;
            leg.blockedTicks = 0; // physical progress = not deadlocked
          }
          break;
        }
      }

      const frontierIndex = leg.nodeIds.length - 1;
      const frontierNode = leg.nodeIds[frontierIndex]!;
      const lag = frontierIndex - leg.progressIndex;
      let changed = false;

      if (frontierNode !== leg.goalNode && lag < this.opts.horizon) {
        const nextNode = moves.get(id);
        if (nextNode !== undefined && nextNode !== frontierNode) {
          // Claim the ENTIRE uncommitted window [current .. candidate] in
          // path order (reservation contract: current cell first). Commit
          // the extension only on a FULL grant — reservations are the
          // source of truth for commanded paths, never advisory.
          const window = leg.nodeIds.slice(leg.progressIndex);
          window.push(nextNode);
          const claimCells = window.map((n) => cellKey(this.map.node(n).pos));
          const granted = this.reservations.claim(id, claimCells);
          if (granted.length === new Set(claimCells).size) {
            leg.nodeIds.push(nextNode);
            leg.blockedTicks = 0;
            changed = true;
          } else {
            leg.blockedTicks++;
            const deniedCell = claimCells[granted.length] ?? claimCells[0]!;
            this.alarms.push(
              `t=${this.tickCount} contention: robot ${id} blocked at ${deniedCell} ` +
                `(owner=${String(this.reservations.owner(deniedCell))}, blockedTicks=${leg.blockedTicks})`
            );
            if (leg.blockedTicks >= this.opts.blockedTicksLimit) {
              this.alarms.push(
                `t=${this.tickCount} robot ${id} blocked ${leg.blockedTicks} ticks at ${deniedCell} — requeueing order ${leg.orderId}`
              );
              void this.adapter.cancelMission(id).catch(() => {
                /* best-effort */
              });
              try {
                this.book.requeue(leg.orderId, "sustained reservation contention");
              } catch {
                /* already terminal */
              }
              this.reservations.releaseAll(id);
              setLeg(rt, undefined);
              continue;
            }
          }
        }
      }

      if (!leg.sent || changed) {
        const missionId = leg.missionId;
        const nodeIds = [...leg.nodeIds];
        void this.adapter
          .sendMission({ id: missionId, robotId: id, nodeIds }, this.map)
          .catch((err) => {
            this.alarms.push(`t=${this.tickCount} sendMission failed for ${id}: ${String(err)}`);
          });
        leg.sent = true;
      }
    }
  }
}
