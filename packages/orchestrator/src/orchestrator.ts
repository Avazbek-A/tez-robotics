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
  /**
   * Blocked-tick count at which a blocked ORDER leg tries to dispatch a
   * yield mission to a parked idle robot standing in its way, well before
   * the deadlock backstop (blockedTicksLimit) gives up on the order.
   * Default 6.
   *
   * Effectively DISABLES yield dispatch when set to 0 (blockedTicks is
   * always incremented to at least 1 before the `=== yieldAfterTicks` check
   * ever runs, so 0 can never match) or to any value >= blockedTicksLimit
   * (the deadlock backstop always fires first and clears the leg before
   * blockedTicks could climb that high) — both degrade cleanly to pre-#13
   * backstop-only behavior, never worse.
   */
  yieldAfterTicks?: number;
  /**
   * Minimum ticks between two yield dispatches to the SAME robot, so a
   * yielded robot is not ping-ponged. Default 20.
   */
  yieldCooldownTicks?: number;
  /**
   * Ticks without physical progress (progressIndex advance) after which a
   * legged robot's mission is presumed stuck and recovered; must exceed
   * blockedTicksLimit so the contention backstop wins where both apply.
   * Default 40.
   *
   * Coupling with offlineGraceMs: this watchdog (and the off-window check
   * alongside it) only ever evaluates while the robot is reported ONLINE —
   * see runRouting()'s `if (rt.online)` gate. A robot that goes offline is
   * exclusively handleOfflineTimeouts()'s responsibility, gated on its own
   * `offlineGraceMs` (a wall-clock duration, not a tick count). If
   * `offlineGraceMs` (converted to ticks at the configured `tickMs`)
   * outlasts `watchdogTicks`, that's fine — the gate means this watchdog
   * simply never gets a chance to fire on that robot until it reports back
   * online, so recovery still correctly goes through the offline path
   * first, with its own, more accurate alarm.
   */
  watchdogTicks?: number;
  /** Injectable clock (ms epoch), for deterministic tests. Default Date.now. */
  now?: () => number;
}

interface RobotLeg {
  kind: "order" | "yield";
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
  /**
   * Consecutive routing ticks the robot's reported node was NOT found
   * anywhere in its committed window (nodeIds.slice(progressIndex)) —
   * physical drift off the committed path (#14). Reset to 0 whenever back
   * on-window.
   */
  offWindowTicks: number;
  /**
   * tickCount at leg creation, and refreshed whenever progressIndex
   * genuinely advances (or a handleMissionDone resume reseeds the leg — a
   * resume IS progress). Used by the physical-progress watchdog (#15) to
   * detect a connected-but-stalled robot that neither blocked-branch
   * counter can see.
   */
  lastProgressTick: number;
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
  /**
   * Tick of this robot's most recent yield dispatch that actually committed
   * physical movement (its leg's first successful extension past its
   * single starting node — see runRouting()'s extension-success branch),
   * for yieldCooldownTicks anti-thrash. Deliberately NOT set at yield
   * dispatch time (tryDispatchYield()) itself: a yield leg that never gets
   * a chance to extend before being iterated-order-evaporated (see the
   * send-guard in runRouting()) must not burn the cooldown window on a
   * no-op — the blocked episode should be free to retry sooner.
   */
  lastYieldTick?: number;
  /**
   * Review round 3 (#13/#15 interaction): set ONLY by executeRecovery()'s
   * watchdog path (never by contention-backstop or off-window recovery —
   * those recover a healthy robot from unlucky circumstances, not a
   * malfunctioning one) to `tickCount + opts.watchdogTicks` at the moment
   * a stalled robot's leg is force-cleared. runDispatch() excludes the
   * robot from the idle pool until this tick passes: without it, a robot
   * whose watchdog just fired (still reporting healthy status, so nothing
   * else excludes it) is instantly re-picked by Hungarian (often the
   * CLOSEST candidate, being wherever it got stuck) for a fresh order that
   * promptly restalls the same way — burning the order's 3-retry cap in
   * roughly 3x watchdogTicks while other, genuinely healthy robots sit
   * idle. The robot must prove it can hold still without re-stalling
   * (silently, no leg to fail) before re-earning dispatch eligibility.
   */
  dispatchCooldownUntilTick?: number;
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
 * Yield dispatch (#13, mitigates the parked-idle-robot case below): when a
 * blocked ORDER leg's blockedTicks reaches `opts.yieldAfterTicks` (well
 * before the deadlock backstop), the orchestrator looks for a single
 * qualifying parked idle robot standing in its way and commands it out of
 * the way with an ordinary "yield" leg — routed and reservation-gated by
 * the exact same machinery as any order leg, so the collision invariant is
 * untouched. See `tryDispatchYield()`.
 *
 * Known accepted limitation (BACKLOG, not fixed here): yield dispatch
 * targets ONE blocker at a time. A multi-robot CHAINED blockage — the
 * yield target itself boxed in by a second parked robot, and so on — has
 * no qualifying single-hop yield target and falls back to the deadlock
 * backstop (`opts.blockedTicksLimit` consecutive fully-blocked ticks
 * requeues the order; after 3 requeues OrderBook fails it outright) exactly
 * as before yield dispatch existed — strictly no worse than pre-#13
 * behavior.
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
  /** Count of alarms evicted by `pushAlarm()`'s ring-buffer cap so far (never resets). */
  private droppedAlarms = 0;
  /** Ring-buffer cap for `alarms` — see `pushAlarm()`. */
  private static readonly ALARM_CAP = 500;
  private readonly cycleTimes: number[] = [];
  private completions = 0;
  private tickCount = 0;
  private yieldCounter = 0;
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
      yieldAfterTicks: opts?.yieldAfterTicks ?? 6,
      yieldCooldownTicks: opts?.yieldCooldownTicks ?? 20,
      watchdogTicks: opts?.watchdogTicks ?? 40,
      now: opts?.now,
    };
    // Minor 6: config sanity alarms — surfaced (not thrown, not clamped: the
    // caller may have deliberate reasons, e.g. a test isolating one
    // mechanism from another) at construction time so a misconfiguration
    // that silently disables a whole recovery mechanism is visible from
    // tick 0 rather than only inferable from its absence during a soak.
    if (this.opts.watchdogTicks <= this.opts.blockedTicksLimit) {
      this.pushAlarm(
        `t=0 config: watchdogTicks (${this.opts.watchdogTicks}) <= blockedTicksLimit ` +
          `(${this.opts.blockedTicksLimit}) — the physical-progress watchdog (#15) may fire ` +
          `before the contention backstop gets a chance to resolve a genuinely-blocked (not ` +
          `just stalled) leg; see watchdogTicks' doc comment`
      );
    }
    if (this.opts.yieldAfterTicks >= this.opts.blockedTicksLimit) {
      this.pushAlarm(
        `t=0 config: yieldAfterTicks (${this.opts.yieldAfterTicks}) >= blockedTicksLimit ` +
          `(${this.opts.blockedTicksLimit}) — yield dispatch (#13) is effectively disabled, the ` +
          `deadlock backstop always fires first; see yieldAfterTicks' doc comment`
      );
    }
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

  /**
   * Appends one alarm, then caps the log at `ALARM_CAP` entries (drop-
   * oldest) so a long-running orchestrator that hits sustained contention
   * or repeated failures doesn't grow `alarms` unboundedly — every alarm
   * call site pushes through here rather than touching `this.alarms`
   * directly. Evicted entries are counted in `droppedAlarms`, surfaced by
   * `getAlarms()` as a synthetic head line rather than silently lost.
   */
  private pushAlarm(msg: string): void {
    this.alarms.push(msg);
    if (this.alarms.length > Orchestrator.ALARM_CAP) {
      const overflow = this.alarms.length - Orchestrator.ALARM_CAP;
      this.alarms.splice(0, overflow);
      this.droppedAlarms += overflow;
    }
  }

  /** Test/debug hook: alarm log accumulated so far (contention, quarantine, offline, failures). */
  getAlarms(): string[] {
    const head = this.droppedAlarms > 0 ? [`(${this.droppedAlarms} older alarms dropped)`] : [];
    return [...head, ...this.alarms];
  }

  /** Test/debug hook: reservation-table ownership pass-through, for asserting collision-hole-free recovery around the deadlock backstop. */
  _reservationOwner(cell: CellKey): RobotId | undefined {
    return this.reservations.owner(cell);
  }

  // ---- tick pipeline -----------------------------------------------------

  private runTick(): void {
    // Top-level guard: this runs off a bare setInterval callback in
    // start(), so an uncaught exception here would otherwise be an
    // unhandled error that can crash the process. Log and skip the rest of
    // this tick rather than taking the whole fleet down; the next tick
    // gets a fresh chance.
    //
    // Ordering invariant — own-cell reservation ownership after
    // releaseAll()/setLeg(undefined): resolveCurrentNodes() (step 2,
    // below) is what normally re-establishes an idle robot's ownership of
    // the cell it's physically sitting on (see its own "idle robots own
    // their cell" claim). Any path that calls
    // `this.reservations.releaseAll(id)` + `setLeg(rt, undefined)` DURING
    // event draining (step 1 — e.g. handleMissionDone's premature-guard,
    // handleMissionFailed, verifyReportingRobot's stale-report cleanup)
    // can safely rely on resolveCurrentNodes() running immediately
    // afterward, same tick, to re-claim that cell before runDispatch/
    // runRouting (steps 4-5) ever run. Any release path that instead runs
    // AFTER resolveCurrentNodes() — currently handleOfflineTimeouts()
    // (step 3) and requeueBlockedLeg() (called from within runRouting(),
    // step 5) — has NO such safety net for the remainder of THIS tick, and
    // MUST re-claim the robot's own current cell itself, synchronously,
    // right after its own releaseAll() call, or the cell is left unowned
    // (claimable by another robot processed later this tick, and
    // unrecoverable by this robot's own idle re-claim next tick, since
    // claim() is a no-op on an empty/foreign-owned grant) — see
    // requeueBlockedLeg() and handleOfflineTimeouts() for the concrete
    // fix shape.
    try {
      this.tickCount++;
      const events = this.eventQueue.splice(0, this.eventQueue.length);
      for (const ev of events) this.handleEvent(ev);

      this.resolveCurrentNodes();
      this.handleOfflineTimeouts();
      this.runDispatch();
      this.runRouting();
    } catch (err) {
      this.pushAlarm(`t=${this.tickCount} tick threw: ${String(err)}`);
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
        const wasOffline = !rt.online;
        rt.online = e.online;
        if (e.online) {
          rt.offlineSinceMs = undefined;
          rt.offlineHandled = false;
          // Reconnect-instant-fire fix: the #15 watchdog is gated off
          // entirely while rt.online is false (see runRouting()), but that
          // gate alone does NOT freeze leg.lastProgressTick — tickCount
          // keeps advancing every tick regardless of connectivity. A robot
          // offline for longer than watchdogTicks (but still short of
          // offlineGraceMs, so handleOfflineTimeouts() hasn't claimed it
          // yet) would otherwise get the watchdog gate lifted back on the
          // very first post-reconnect tick with an already-expired clock,
          // firing before the robot can report so much as a single tick of
          // real movement. Reconnecting is not itself progress, but it DOES
          // deserve a fresh window to prove it: refresh lastProgressTick (and
          // offWindowTicks, for the same reason — a stale positional snap
          // from before the outage shouldn't count against it either) to
          // this tick, exactly like a genuine progress advance would.
          if (wasOffline && rt.leg) {
            rt.leg.lastProgressTick = this.tickCount;
            rt.leg.offWindowTicks = 0;
          }
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
    this.pushAlarm(
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

    // #13: yield events are identified by MISSION-ID SHAPE (`yield:` prefix),
    // not by the robot's CURRENT leg kind, and handled entirely here, before
    // parseMissionId/order-book logic — they never touch the order book at
    // all. This must be shape-based, not `rt.leg?.kind === "yield"`-based:
    // a late/stale event for an OLD yield missionId can drain after that
    // yield leg already completed and was superseded by a brand-new ORDER
    // leg (robot went idle, got re-dispatched, all before the stale event
    // arrived) — `rt.leg?.kind` would then read "order", and this check
    // would wrongly fall through to parseMissionId ("yield:r2#1" parses to
    // leg "r2#1", neither "pick" nor "drop", so `!parsed` — see the
    // corresponding regression in handleMissionFailed's unparseable-id
    // branch, which does clear rt.leg unconditionally). Only clear when the
    // CURRENT leg is still that same yield mission; any other case
    // (superseded, or no leg at all) is a stale report — ignore it, and
    // critically do NOT fall through into parseMissionId/order logic.
    if (missionId.startsWith("yield:")) {
      if (rt.leg?.kind === "yield" && rt.leg.missionId === missionId) {
        setLeg(rt, undefined); // yield done (or harmlessly cut short)
      } else {
        this.pushAlarm(
          `t=${this.tickCount} stale yield missionDone from robot ${robotId} for ${missionId} — ignoring`
        );
      }
      return;
    }

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
      const currentLeg = rt.leg;
      const reachedGoal = rt.currentNodeId === currentLeg.goalNode || rt.lastVdaNodeId === currentLeg.goalNode;
      if (!reachedGoal) {
        // Task 2 regression fix: under horizon-gated/reservation-blocked
        // extension, the orchestrator can DELIBERATELY send a mission
        // shorter than the leg's true goal (paused by opts.horizon, or by
        // sustained reservation contention) — and a real adapter
        // truthfully reports THAT sent mission as fully processed the
        // moment the robot finishes walking it, regardless of whether it
        // matches the leg's eventual goal: Vda5050Adapter's
        // handleOrderProcessed() `!active` branch and FakeAdapter.tick()'s
        // `currentNodeIndex >= nodeIds.length` check both only know about
        // the specific path they were told to walk, never about the leg's
        // goal. Distinguish that legitimate "committed prefix fully
        // executed" case from a genuinely premature/corrupt report: if the
        // robot's batch-fresh node is exactly the leg's committed FRONTIER
        // (the last node it was actually sent), this is case (a) — resume,
        // don't cancel+requeue. Anything else (robot short of even its own
        // frontier) is case (b), a genuine frontier race / corrupt report —
        // falls through to the existing cancel+requeue path unchanged.
        // Mirror reachedGoal's dual-signal check (currentNodeId OR
        // lastVdaNodeId), not just currentNodeId: under a real
        // Vda5050Adapter, the AGV's own reported lastNodeId
        // (rt.lastVdaNodeId) can reach the frontier a full batch ahead of
        // the position-snap-derived currentNodeId — the exact race
        // RobotRuntime.lastVdaNodeId's doc comment describes. Checking
        // currentNodeId alone would spuriously read "not at frontier" in
        // that window and misroute a legitimately-finished robot into the
        // genuine-premature cancel+requeue branch below — a narrower
        // reintroduction of this same regression, just gated on which
        // signal arrives first instead of on horizon/contention pacing.
        const frontierNode = currentLeg.nodeIds[currentLeg.nodeIds.length - 1];
        const atFrontier =
          currentLeg.nodeIds.length > 0 &&
          (rt.currentNodeId === frontierNode || rt.lastVdaNodeId === frontierNode);
        if (atFrontier) {
          // Resume: reseed the leg from the CONFIRMED frontier position
          // exactly like a freshly-created leg, so runRouting() sends a
          // brand-new mission attempt under the SAME missionId next tick,
          // and extension naturally continues once opts.horizon/reservation
          // contention allows. Both adapters treat a post-done send under a
          // reused missionId as a fresh attempt (Vda5050Adapter mints a new
          // `${missionId}#n`; FakeAdapter already cleared `robot.mission`
          // the instant it fired this very missionDone event, synchronously,
          // before this handler even runs) — and FakeAdapter's "new
          // mission" branch sets the robot's position to the FIRST node of
          // the sent path, so nodeIds MUST start at the robot's true
          // current node. Seed with `frontierNode` itself — NOT
          // `rt.currentNodeId` — since atFrontier can be true purely via
          // `rt.lastVdaNodeId` while `rt.currentNodeId` is still stale
          // (possibly even `undefined`); frontierNode IS whichever signal
          // confirmed arrival, matching reachedGoal's own established
          // precedent of trusting lastVdaNodeId as authoritative over a
          // disagreeing/absent position snap (progressIndex reset to 0
          // keeps it monotonic: 0 is always a valid — and here the only —
          // index into the new, single-element nodeIds).
          this.pushAlarm(
            `t=${this.tickCount} committed path complete (not yet leg goal) for robot ${robotId}, ` +
              `order ${orderId} (leg=${leg}, at=${String(rt.currentNodeId)}, lastVdaNodeId=${String(rt.lastVdaNodeId)}, ` +
              `goal=${currentLeg.goalNode}) — resuming, not requeueing`
          );
          currentLeg.nodeIds = [frontierNode!];
          currentLeg.progressIndex = 0;
          // A resume IS progress: the robot has just confirmed reaching its
          // committed frontier, so both the off-window transient-snap
          // counter and the physical-progress watchdog clock must reset
          // here exactly like the ordinary progress-scan path does, or a
          // robot legitimately pacing out repeated horizon/contention-paused
          // resumes would eventually trip the watchdog despite genuinely
          // making progress every time.
          currentLeg.offWindowTicks = 0;
          currentLeg.lastProgressTick = this.tickCount;
          // Deliberately NOT resetting blockedTicks here: doing so proved to
          // be its own deadlock — a robot with NO viable further extension
          // (e.g. genuinely, permanently blocked by another parked robot)
          // completes this trivial "already there" 1-node re-send instantly
          // every tick, re-entering this exact resume branch every single
          // time; unconditionally zeroing blockedTicks on every resume
          // silently absorbed the deadlock backstop's counter before it
          // could ever reach opts.blockedTicksLimit, leaving the order
          // hung "dispatched" forever instead of ever reaching the
          // backstop or genuinely completing. blockedTicks must only ever
          // be reset by GENUINE forward progress — runRouting()'s own
          // progress-scan (which advances progressIndex to a NEW, higher
          // index) already does exactly that, unconditionally, on real
          // movement, and its successful-extension branch resets it too.
          // Leaving it untouched here means: if this robot is truly stuck,
          // repeated resume-then-immediately-redone cycles correctly keep
          // accumulating blockedTicks (nothing else resets it) until the
          // deadlock backstop fires; if it's genuinely progressing (just
          // pacing out its horizon), the very next successful extension
          // resets it via that existing path regardless.
          currentLeg.sent = false;
          return;
        }

        this.pushAlarm(
          `t=${this.tickCount} premature missionDone from robot ${robotId} for order ${orderId} ` +
            `(leg=${leg}, at=${String(rt.currentNodeId)}, lastVdaNodeId=${String(rt.lastVdaNodeId)}, goal=${currentLeg.goalNode}) — cancelling and requeueing`
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
        kind: "order",
        orderId,
        phase: "drop",
        goalNode: order.dropNode,
        missionId: `${orderId}:drop`,
        nodeIds: [], // seeded once this tick's current node is resolved
        sent: false,
        progressIndex: 0,
        blockedTicks: 0,
        offWindowTicks: 0,
        lastProgressTick: this.tickCount,
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

    // #13: same shape-based yield short-circuit as handleMissionDone — see
    // its comment for why this MUST be keyed on missionId shape rather than
    // `rt.leg?.kind`. This is the branch where getting that wrong is
    // actively destructive: a late `yield:<id>#<n>` missionFailed draining
    // AFTER the yield leg was superseded by a new ORDER leg would otherwise
    // fall through to the `!parsed` branch below (a "yield:" missionId
    // never matches parseMissionId's "<orderId>:pick|drop" shape), which
    // unconditionally does `setLeg(rt, undefined)` — silently killing the
    // robot's live order leg while the order itself stays "dispatched"/
    // "underway" in the book forever (robot excluded from redispatch by
    // `!rt.leg` never re-admitting it, order never requeued because nothing
    // called book.requeue) — a permanently hung order.
    if (missionId.startsWith("yield:")) {
      if (rt.leg?.kind === "yield" && rt.leg.missionId === missionId) {
        setLeg(rt, undefined);
        this.pushAlarm(
          `t=${this.tickCount} yield mission failed for robot ${robotId}: ${reason}`
        );
      } else {
        this.pushAlarm(
          `t=${this.tickCount} stale yield missionFailed from robot ${robotId} for ${missionId} — ignoring`
        );
      }
      return;
    }

    const parsed = parseMissionId(missionId);
    if (!parsed) {
      // Can't even tell which order this was for; just stop this robot
      // driving anything further and log it.
      setLeg(rt, undefined);
      this.pushAlarm(
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
    this.pushAlarm(`t=${this.tickCount} mission failed for robot ${robotId}: ${reason}`);
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
          this.pushAlarm(
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
        this.pushAlarm(`t=${this.tickCount} robot ${id} position recovered, un-quarantined`);
        if (rt.state.status === "ERROR") rt.state.status = "IDLE";
      }

      rt.currentNodeId = nodeId;
      this.reservations.release(id, cellKey(this.map.node(nodeId).pos));
      if (!rt.leg) {
        // Idle robots always own the cell they are parked on, so no other
        // robot's committed window can ever be granted through them.
        const idleCell = cellKey(this.map.node(nodeId).pos);
        const granted = this.reservations.claim(id, [idleCell]);
        if (granted.length === 0) {
          // Should be unreachable in a correctly-functioning fleet — the
          // only way another robot could already foreign-own the cell
          // THIS robot is physically standing on is a prior collision-hole
          // bug (see runTick()'s ordering-invariant note and
          // requeueBlockedLeg()/handleOfflineTimeouts()'s own-cell
          // re-claims). Alarmed here, not silently swallowed, so the "idle
          // robots own their cell" invariant is directly observable if it
          // is ever violated again.
          this.pushAlarm(
            `t=${this.tickCount} robot ${id} idle self-claim of ${idleCell} DENIED ` +
              `(owner=${String(this.reservations.owner(idleCell))}) — collision-hole invariant violated`
          );
        }
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
      // Minor 4: capture what's ACTUALLY about to happen to this robot's
      // leg before it's cleared below, so the closing alarm reports truth
      // instead of unconditionally claiming "order requeued" — a robot that
      // went offline mid-YIELD has no order to requeue at all (yield legs
      // never touch the book, same as everywhere else in this file), and a
      // robot that was simply idle when it dropped offline has neither.
      const hadYieldLeg = rt.leg?.kind === "yield";
      const order = this.book.byRobot(asCoreRobotId(id));
      if (order) {
        try {
          this.book.requeue(order.id, "robot offline beyond grace period");
        } catch {
          /* already terminal */
        }
      }
      this.reservations.releaseAll(id);
      // Re-claim the robot's own physically-occupied cell immediately —
      // same collision-hole fix as requeueBlockedLeg(), and needed here
      // for the same reason: this runs at pipeline step 3
      // (handleOfflineTimeouts), AFTER resolveCurrentNodes() (step 2)
      // already ran this tick, so nothing else re-establishes ownership
      // before runRouting() (step 5) runs later THIS SAME tick. Without
      // this, the offline robot's cell is unowned for the rest of this
      // tick's runRouting() — another robot's committed window can get a
      // FULL grant through it (PIBT still pushes the frozen robot
      // virtually, so it doesn't stop that OTHER robot's proposed move
      // either) — and on the VERY NEXT tick, resolveCurrentNodes()'s own
      // idle re-claim for this robot would then see the cell as
      // foreign-owned and never recover it: a permanent collision hole
      // where a traveling robot's commanded path drives straight through
      // where the frozen, offline robot physically still sits. See the
      // ordering invariant noted on runTick().
      if (rt.currentNodeId !== undefined) {
        this.reservations.claim(id, [cellKey(this.map.node(rt.currentNodeId).pos)]);
      }
      setLeg(rt, undefined);
      void this.adapter.cancelMission(id).catch(() => {
        /* best-effort; robot is unreachable anyway */
      });
      const outcome = order ? "order requeued" : hadYieldLeg ? "yield abandoned" : "no active work";
      this.pushAlarm(`t=${this.tickCount} robot ${id} offline > ${grace}ms — ${outcome}, mission cancelled`);
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
      // Review round 3: a robot just recovered by the #15 watchdog reports
      // no leg and no bad status — nothing else here excludes it — so
      // without this it is instantly re-admitted to the idle pool and
      // Hungarian, being distance-greedy, typically re-picks it FIRST
      // (often the closest candidate, being wherever it just got stuck),
      // promptly re-stalling the SAME way and burning the new order's
      // 3-retry cap in roughly 3x watchdogTicks while other genuinely
      // healthy robots sit idle. Contention-backstop and off-window
      // recoveries do NOT set this cooldown (see executeRecovery) — those
      // recover a healthy robot from unlucky circumstances (a temporary
      // blocker, a drift event), not a suspected malfunction; only the
      // watchdog — "this robot stopped making progress for no externally
      // visible reason" — earns a mandatory cooldown to prove it can hold
      // still before re-earning dispatch eligibility.
      const cooling =
        rt.dispatchCooldownUntilTick !== undefined && this.tickCount < rt.dispatchCooldownUntilTick;
      const isFreeIdle = !rt.leg && !badStatus && !cooling && !this.book.byRobot(asCoreRobotId(id));
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
        kind: "order",
        orderId: order.id,
        phase: "pick",
        goalNode: order.pickupNode,
        missionId: `${order.id}:pick`,
        nodeIds: [rt.currentNodeId],
        sent: false,
        progressIndex: 0,
        blockedTicks: 0,
        offWindowTicks: 0,
        lastProgressTick: this.tickCount,
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
   * A parked IDLE robot sitting on the only path into an order's
   * pickup/drop permanently owns that cell (see resolveCurrentNodes()) but
   * is never itself commanded to move out of the way by PIBT — PIBT only
   * ever pushes it virtually. Below, once a blocked ORDER leg's
   * blockedTicks reaches `opts.yieldAfterTicks`, `tryDispatchYield()`
   * mitigates this by commanding a single qualifying parked blocker out of
   * the way (#13).
   *
   * Known accepted limitation (BACKLOG, not fixed here): yield dispatch
   * only ever targets ONE blocker; a multi-robot chained blockage still
   * falls back to the deadlock backstop below, which requeues the order,
   * and after 3 requeues OrderBook fails it outright, rather than ever
   * being routed around the parked robot(s).
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
            leg.lastProgressTick = this.tickCount; // #15: progress resets the watchdog clock
            leg.offWindowTicks = 0;
          }
          break;
        }
      }

      // #14/#15 are both skipped while the robot is reported OFFLINE: that
      // recovery is already handleOfflineTimeouts()'s job, gated on its own
      // opts.offlineGraceMs. Without this gate, an offline robot whose
      // offlineGraceMs (in ms) outlasts watchdogTicks*tickMs would get its
      // leg cleared and its order requeued HERE first, under a misleading
      // "no physical progress" alarm that never mentions the robot is
      // actually unreachable — and worse, would hand it straight back into
      // the dispatch pool as if it were a healthy idle robot. See
      // watchdogTicks' own doc comment for this coupling.
      if (rt.online) {
        // #14: robot's reported node is nowhere on its committed path at
        // all — physical drift (avoidance swerve, teleop, bump). Checked
        // against the WHOLE committed leg.nodeIds, not a window sliced from
        // progressIndex onward, and rt.lastVdaNodeId is also accepted as a
        // second, independent on-path signal — both fixes are load-bearing,
        // caught by review against the first version of this check:
        //
        // (a) full-path, not windowed: rt.currentNodeId is written by BOTH
        // the positional snap (handleEvent's "state" case, which
        // unconditionally overwrites — even to an OLDER, already-passed,
        // still-valid node) and the authoritative missionProgress-derived
        // lastNodeId (handleEvent's "missionProgress" case) — see
        // RobotRuntime.lastVdaNodeId's own doc comment for the exact race
        // this produces. A truthful snap can legitimately arrive lagging
        // BEHIND progressIndex (an already-passed node the robot is no
        // longer standing on, but which the leg genuinely traversed) —
        // slicing the membership test from progressIndex onward would
        // wrongly flag that routine lag as off-path.
        //
        // (b) rt.lastVdaNodeId also accepted: mirrors the same dual-signal
        // precedent handleMissionDone's reachedGoal/atFrontier guards
        // establish. This one matters even with fix (a) applied: after a
        // frontier-race RESUME, the leg is reseeded to JUST [frontierNode]
        // (see that branch's own comment) — a stale positional snap still
        // reporting the leg's PREVIOUS, now fully-discarded path would never
        // be found in the new nodeIds at all, checked in full or otherwise,
        // yet rt.lastVdaNodeId (confirmed via missionProgress) IS the
        // frontier itself and correctly proves the robot is fine.
        //
        // Two consecutive ticks required: a single stale positional snap is
        // routine and must not kill a healthy leg.
        //
        // Accepted tradeoff: a robot physically bumped BACKWARD onto an
        // already-passed path node reads as on-path (full-path membership
        // makes no distinction between ahead-of and behind-progressIndex),
        // so #14 never fires for it and progressIndex never re-advances
        // either — the #15 watchdog is what eventually catches this case,
        // once lastProgressTick ages past watchdogTicks with no further
        // forward progress.
        const onCommittedPath =
          leg.nodeIds.includes(rt.currentNodeId) ||
          (rt.lastVdaNodeId !== undefined && leg.nodeIds.includes(rt.lastVdaNodeId));
        if (!onCommittedPath) {
          leg.offWindowTicks++;
          if (leg.offWindowTicks >= 2) {
            this.recoverLeg(id, rt, leg, `off committed path at ${rt.currentNodeId}`, false);
            continue;
          }
        } else {
          leg.offWindowTicks = 0;
        }

        // #15: no physical progress for watchdogTicks — stuck-but-connected
        // robot (fully-extended frontier, or lag-capped stall) that neither
        // blocked-branch counter can see. watchdogTicks (default 40) is set
        // greater than blockedTicksLimit (default 20): the contention
        // backstop above wins whenever it would reach its own limit first
        // (any genuinely-blocked-extension scenario resolves — one way or
        // the other — well before this threshold), and this watchdog covers
        // the rest: frontier already at goal (no extension ever attempted,
        // so blockedTicks never moves off 0), or claims keep succeeding but
        // the robot itself never physically moves.
        if (this.tickCount - leg.lastProgressTick >= this.opts.watchdogTicks) {
          this.recoverLeg(id, rt, leg, "no physical progress (watchdog)", true);
          continue;
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
          // claim() dedupes path revisits internally, so the grant it can
          // ever return is capped at the number of DISTINCT cells in the
          // window — compare/index against that deduped list, not the raw
          // (possibly-revisiting) one, or a revisited window both
          // mis-detects a full grant as partial and names the wrong denied
          // cell (finding: minor 6).
          const dedupedCells = Array.from(new Set(claimCells));
          const granted = this.reservations.claim(id, claimCells);
          if (granted.length === dedupedCells.length) {
            // Review round 3 (#13 fix): a yield leg's cooldown is earned
            // HERE, on its first genuine extension, not at dispatch time —
            // see RobotRuntime.lastYieldTick's doc comment for why (a yield
            // that never gets a chance to extend before being evaporated —
            // see the send-guard below — must not burn the cooldown on a
            // no-op retry).
            if (leg.kind === "yield" && leg.nodeIds.length === 1) {
              rt.lastYieldTick = this.tickCount;
            }
            leg.nodeIds.push(nextNode);
            leg.blockedTicks = 0;
            changed = true;
          } else {
            leg.blockedTicks++;
            const deniedCell = dedupedCells[granted.length] ?? dedupedCells[0]!;
            this.pushAlarm(
              `t=${this.tickCount} contention: robot ${id} blocked at ${deniedCell} ` +
                `(owner=${String(this.reservations.owner(deniedCell))}, blockedTicks=${leg.blockedTicks})`
            );
            if (leg.kind === "order" && leg.blockedTicks === this.opts.yieldAfterTicks) {
              this.tryDispatchYield(id, leg);
            }
            if (leg.blockedTicks >= this.opts.blockedTicksLimit) {
              this.requeueBlockedLeg(id, rt, leg, deniedCell);
              continue;
            }
          }
        } else {
          // PIBT offered no forward candidate this tick — either it
          // returned nothing, or (the canonical case) it resolved to
          // "stay" because the only cell that makes progress is occupied
          // by another PIBT-visible agent, e.g. a parked idle robot (see
          // resolveCurrentNodes()): PIBT's own collision avoidance simply
          // never proposes stepping onto it, so there is no claim() to
          // even attempt against a foreign owner. Sustained inability to
          // advance is sustained inability to advance regardless of which
          // layer reports it — count it as a blocked tick too, so the
          // deadlock backstop still fires for the parked-robot-blocks-the
          // -corridor case, not only for claim() rejections.
          leg.blockedTicks++;
          const stuckCell = cellKey(this.map.node(frontierNode).pos);
          this.pushAlarm(
            `t=${this.tickCount} contention: robot ${id} blocked at ${stuckCell} ` +
              `(no forward candidate, blockedTicks=${leg.blockedTicks})`
          );
          if (leg.kind === "order" && leg.blockedTicks === this.opts.yieldAfterTicks) {
            this.tryDispatchYield(id, leg);
          }
          if (leg.blockedTicks >= this.opts.blockedTicksLimit) {
            this.requeueBlockedLeg(id, rt, leg, stuckCell);
            continue;
          }
        }
      }

      // Review round 3 (#13 fix): a yield leg with exactly ONE committed
      // node (its still-unextended starting position) is a meaningless
      // mission — "go where you already are" — that a real adapter reports
      // as trivially, instantly complete on the very next tick (identical
      // to the frontier-race "resume" case's own already-there re-send
      // logic above), clearing the yield leg via handleMissionDone before
      // extension ever had a chance to physically move the robot out of
      // the way at all. This specifically bites when the blocker robot is
      // iterated AFTER the blocked robot within this same runRouting() pass
      // (tryDispatchYield() is called from the BLOCKED robot's own
      // iteration, part-way through this loop): the blocker's brand-new
      // leg has no real PIBT-computed move for ITS true goal this tick —
      // the `moves` map above was computed at the top of this method,
      // BEFORE the leg existed, when the blocker was still registered as a
      // leg-less agent — so its own extension attempt this tick can resolve
      // to "no forward candidate"/"stay" and nodeIds never grows past 1.
      // Withhold the send entirely until the leg has genuinely extended
      // past its start node; ordinary `!leg.sent || changed` resumes
      // sending normally from the tick that first succeeds onward (that
      // extension sets `changed = true`, unconditionally satisfying this
      // check on the very same iteration).
      const yieldNotYetExtended = leg.kind === "yield" && leg.nodeIds.length === 1;
      if (!yieldNotYetExtended && (!leg.sent || changed)) {
        const missionId = leg.missionId;
        const nodeIds = [...leg.nodeIds];
        void this.adapter
          .sendMission({ id: missionId, robotId: id, nodeIds }, this.map)
          .catch((err) => {
            this.pushAlarm(`t=${this.tickCount} sendMission failed for ${id}: ${String(err)}`);
            // Retry next tick: a rejected send is otherwise never retried
            // once nothing else changes (gated extension means the same
            // nodeIds may not get appended again for a while), hanging the
            // order with no backstop — claim()s can keep succeeding even
            // while the adapter itself keeps rejecting sends. Guard on leg
            // IDENTITY: rt.leg may have been cleared or replaced (leg
            // completed, requeued via an unrelated path, deadlock
            // backstop) while this promise was in flight — only touch the
            // SAME leg object this send was actually for. A resend after a
            // genuinely failed send is a brand-new mission from the
            // adapter's point of view (it recorded nothing), so this can
            // never trip the adapter's strict-prefix check.
            if (rt.leg === leg) {
              leg.sent = false;
            }
          });
        leg.sent = true;
      }
    }
  }

  /**
   * Deadlock backstop recovery: cancel the robot's mission, requeue its
   * order (OrderBook's 3-retry cap then fails it outright rather than
   * hanging forever), release all of the robot's reservation holds, and
   * clear its leg — the same recovery shape as handleMissionFailed(). The
   * actual mechanics (including the critical release+re-claim ordering fix)
   * live in executeRecovery() below; this method owns only the
   * backstop-specific alarm text.
   */
  private requeueBlockedLeg(id: RobotId, rt: RobotRuntime, leg: RobotLeg, deniedCell: CellKey): void {
    // #13: a blocked YIELD leg has no order to requeue — it was never in
    // the order book to begin with (see tryDispatchYield). Log distinctly
    // ("abandoning yield" vs "requeueing order") so alarm text never
    // implies an order was affected when none was; cancel/releaseAll/
    // own-cell re-claim/clear stay identical for both leg kinds — that
    // shared mechanics is factored into executeRecovery() below (also used
    // by recoverLeg(), the #14/#15 recovery entry point), so it exists
    // exactly ONCE in this file.
    if (leg.kind === "order") {
      this.pushAlarm(
        `t=${this.tickCount} robot ${id} blocked ${leg.blockedTicks} ticks at ${deniedCell} — requeueing order ${leg.orderId}`
      );
    } else {
      this.pushAlarm(
        `t=${this.tickCount} robot ${id} blocked ${leg.blockedTicks} ticks at ${deniedCell} — abandoning yield`
      );
    }
    // Deadlock-backstop recovery never sets the dispatch cooldown: a robot
    // stuck behind sustained reservation contention is healthy — the
    // BLOCKER (or lack of a viable path) was at fault, not this robot —
    // see recoverLeg()'s watchdog-only cooldown for the contrasting case.
    this.executeRecovery(id, rt, leg, "sustained reservation contention", false);
  }

  /**
   * #14/#15 recovery entry point: physical off-window drift and the
   * physical-progress watchdog both funnel through here. Pushes the alarm
   * in the shape specified by the design (`t=<n> robot <id> <reason> —
   * recovering (order requeued|yield abandoned)`), then defers to the same
   * executeRecovery() mechanics the deadlock backstop
   * (requeueBlockedLeg()) uses — see that method's doc comment for why the
   * cancel/conditional-requeue/releaseAll/own-cell-re-claim/clear sequence
   * must exist in exactly one place.
   *
   * `cooldown`: review round 3 — true ONLY for the #15 watchdog call site.
   * Off-window drift (#14) recovers a robot that was, until this exact
   * moment, genuinely following its committed path (a transient swerve/bump
   * knocked it off) — nothing suggests it can't immediately be trusted with
   * a fresh order. The watchdog (#15) recovers a robot that silently
   * stopped making progress for no externally visible reason — see
   * RobotRuntime.dispatchCooldownUntilTick's doc comment for why THAT case
   * specifically must not be instantly re-dispatched.
   */
  private recoverLeg(id: RobotId, rt: RobotRuntime, leg: RobotLeg, reason: string, cooldown: boolean): void {
    this.pushAlarm(
      `t=${this.tickCount} robot ${id} ${reason} — recovering ` +
        `(${leg.kind === "order" ? "order requeued" : "yield abandoned"})`
    );
    this.executeRecovery(id, rt, leg, reason, cooldown);
  }

  /**
   * Shared recovery mechanics — the ONE place in this file the sequence
   * (conditional order requeue, best-effort mission cancel, release all
   * reservation holds, synchronously re-claim the robot's own
   * physically-occupied cell, clear the leg) is implemented. Callers own
   * their own alarm text (the deadlock backstop's and #14/#15's alarm
   * shapes differ) and call this afterward for the actual recovery.
   *
   * Critical fix (carried over from the pre-refactor requeueBlockedLeg):
   * release + re-claim must happen together, synchronously, right here.
   * releaseAll() alone would leave the robot's own physically-occupied cell
   * unowned for the REMAINDER of this tick's runRouting() loop
   * (resolveCurrentNodes() — which is what normally claims an idle robot's
   * current cell — already ran earlier this same tick), making it
   * claimable by any OTHER robot processed later in this same loop. Worse,
   * on the VERY NEXT tick, resolveCurrentNodes()'s idle re-claim for THIS
   * robot would then see the cell as foreign-owned and get an empty grant
   * (claim() is a no-op on empty grant), so the robot would never recover
   * ownership of the cell it is still physically sitting on — a genuine
   * collision hole.
   *
   * `cooldown`: when true (the #15 watchdog, exclusively — see recoverLeg's
   * doc comment), stamps RobotRuntime.dispatchCooldownUntilTick so
   * runDispatch() excludes this robot from re-earning work until it proves
   * it can hold still for a full watchdogTicks window.
   */
  private executeRecovery(
    id: RobotId,
    rt: RobotRuntime,
    leg: RobotLeg,
    reason: string,
    cooldown: boolean
  ): void {
    if (leg.kind === "order") {
      try {
        this.book.requeue(leg.orderId, reason);
      } catch {
        /* already terminal */
      }
    }
    void this.adapter.cancelMission(id).catch(() => {
      /* best-effort */
    });
    this.reservations.releaseAll(id);
    if (rt.currentNodeId !== undefined) {
      this.reservations.claim(id, [cellKey(this.map.node(rt.currentNodeId).pos)]);
    }
    if (cooldown) {
      rt.dispatchCooldownUntilTick = this.tickCount + this.opts.watchdogTicks;
    }
    setLeg(rt, undefined);
  }

  /**
   * #13 yield dispatch: when an ORDER leg has been blocked for
   * yieldAfterTicks, look for a parked idle robot standing on the first
   * cell the blocked robot needs next, and command it out of the way with
   * a yield leg — an ordinary leg (kind "yield") with no order attached,
   * routed and reservation-gated by the same machinery as any other leg.
   * Returns true if a yield was dispatched this tick.
   */
  private tryDispatchYield(blockedId: RobotId, blockedLeg: RobotLeg): boolean {
    // 1. The cell the blocked robot needs: its frontier's neighbors sorted
    //    by distance to the leg goal — first one owned by a QUALIFYING
    //    blocker (online, not quarantined, leg-less, resolved node, not
    //    itself the blocked robot, cooldown expired) wins.
    const frontier = blockedLeg.nodeIds[blockedLeg.nodeIds.length - 1]!;
    const wanted = [...this.map.neighbors(frontier)].sort(
      (a, b) => this.map.distance(a, blockedLeg.goalNode) - this.map.distance(b, blockedLeg.goalNode)
    );
    for (const nodeId of wanted) {
      const cell = cellKey(this.map.node(nodeId).pos);
      const ownerId = this.reservations.owner(cell);
      if (ownerId === undefined || ownerId === blockedId) continue;
      const blocker = this.robots.get(ownerId);
      if (
        !blocker ||
        blocker.leg ||
        blocker.quarantined ||
        !blocker.online ||
        blocker.currentNodeId === undefined ||
        (blocker.lastYieldTick !== undefined &&
          this.tickCount - blocker.lastYieldTick < this.opts.yieldCooldownTicks)
      ) {
        continue;
      }
      const target = this.findYieldTarget(ownerId, blocker.currentNodeId, nodeId, blockedLeg);
      if (target === undefined) continue;
      // Review round 3: lastYieldTick is deliberately NOT set here — see its
      // doc comment on RobotRuntime. It's set later, in runRouting()'s
      // extension-success branch, the first time this leg's nodeIds
      // actually grows past its single starting node — i.e. only once the
      // yield has committed real physical movement, not merely been
      // dispatched.
      this.yieldCounter++;
      setLeg(blocker, {
        kind: "yield",
        orderId: "",
        phase: "pick",
        goalNode: target,
        missionId: `yield:${ownerId}#${this.yieldCounter}`,
        nodeIds: [blocker.currentNodeId],
        sent: false,
        progressIndex: 0,
        blockedTicks: 0,
        offWindowTicks: 0,
        lastProgressTick: this.tickCount,
      });
      this.pushAlarm(
        `t=${this.tickCount} yield: robot ${ownerId} at ${nodeId} asked to vacate to ${target} (blocking ${blockedId})`
      );
      return true;
    }
    return false;
  }

  /**
   * BFS from the blocker's node (depth cap 10) for the nearest node whose
   * cell is unowned (or the blocker's own), not physically occupied by any
   * robot, not the cell being vacated, not anywhere on the BLOCKED robot's
   * own future route (including its ultimate goal — see below), and no
   * CLOSER to that blocked goal than the vacated cell already was. Undefined
   * when nothing suitable is reachable.
   *
   * Excluding the blocked robot's route: a candidate node here is, by
   * definition, unreserved (nothing has claimed it yet — that's exactly why
   * it's a candidate), so without this exclusion the search can and did
   * (caught in review, reproduced live) land the blocker exactly on the
   * blocked robot's own drop/pickup node, or partway down the same
   * corridor toward it — trading one deadlock for an equivalent or worse
   * one instead of actually clearing the path. `blockedLeg.nodeIds.slice(
   * progressIndex)` is the robot's remaining committed path so far;
   * `blockedLeg.goalNode` is added explicitly since the path hasn't been
   * extended all the way to it yet in the blocked state this is called
   * from. The distance non-decrease requirement (candidate no closer to
   * blockedLeg.goalNode than `vacating` was) is a second, independent
   * layer against the same failure mode for nodes NOT literally on the
   * known route — e.g. an as-yet-unclaimed parallel corridor cell that
   * still happens to be closer to the blocked robot's goal — steering the
   * blocker to step ASIDE or AWAY rather than merely further down the
   * blocked robot's own path.
   */
  private findYieldTarget(
    blockerId: RobotId,
    from: string,
    vacating: string,
    blockedLeg: RobotLeg
  ): string | undefined {
    const occupiedNodes = new Set<string>();
    for (const [, rt] of this.robots) {
      if (rt.currentNodeId !== undefined) occupiedNodes.add(rt.currentNodeId);
    }
    const blockedRoute = new Set(blockedLeg.nodeIds.slice(blockedLeg.progressIndex));
    blockedRoute.add(blockedLeg.goalNode);
    const vacatingDistance = this.map.distance(vacating, blockedLeg.goalNode);
    const seen = new Set<string>([from]);
    let frontier = [from];
    for (let depth = 0; depth < 10; depth++) {
      const next: string[] = [];
      for (const nodeId of frontier) {
        // Explored breadth-first through EVERY graph-adjacent node,
        // including ones currently occupied by another robot: this loop is
        // a graph-distance search for a landing spot, not a simulated
        // physical route, so walking the search through an occupied node
        // commits nothing — actual physical movement toward whatever node
        // is ultimately returned is still gated by the ordinary
        // reservation-claimed extension in runRouting(), same as any leg.
        // `seen` already excludes `from` from ever being re-proposed as a
        // neighbor of itself, so no separate `nb !== from` check is needed.
        for (const nb of this.map.neighbors(nodeId)) {
          if (seen.has(nb)) continue;
          seen.add(nb);
          const cell = cellKey(this.map.node(nb).pos);
          const ownerId = this.reservations.owner(cell);
          const eligible =
            nb !== vacating &&
            !blockedRoute.has(nb) &&
            !occupiedNodes.has(nb) &&
            (ownerId === undefined || ownerId === blockerId) &&
            this.map.distance(nb, blockedLeg.goalNode) >= vacatingDistance;
          if (eligible) return nb;
          next.push(nb);
        }
      }
      frontier = next;
    }
    return undefined;
  }
}
