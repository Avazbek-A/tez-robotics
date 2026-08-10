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
   * Nominal look-ahead horizon in cells. v1 simplification: only the
   * immediate next cell is genuinely committed per tick (see design notes
   * in task-10-report.md) — this option is accepted for forward
   * compatibility but not yet used to precompute a deeper reservation
   * horizon.
   */
  horizon?: number;
  /** Grace period before an offline robot's order is requeued. Default 10000ms. */
  offlineGraceMs?: number;
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
}

interface RobotRuntime {
  state: RobotState;
  online: boolean;
  offlineSinceMs?: number;
  offlineHandled: boolean;
  quarantined: boolean;
  currentNodeId?: string;
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
 * Orchestrator: wires map + router + reservations + dispatcher + order book
 * + RobotAdapter into a tick loop.
 *
 * Pipeline per tick, see task-10-report.md for full design rationale:
 *   1. drain queued adapter events (robot registry, order lifecycle)
 *   2. resolve each robot's current map node; quarantine unresolvable ones
 *   3. requeue orders for robots offline beyond the grace period
 *   4. dispatch idle robots x queued orders (Hungarian)
 *   5. PIBT step for all routable robots; extend/send missions for active
 *      legs; reservation claim as a contention-detecting safety net
 *
 * IMPORTANT — v1 lockstep precondition (see task-10-report.md §5): the
 * "no two robots ever share a cell" guarantee comes entirely from PIBT's
 * `step()` being called once per tick over the FULL set of currently
 * routable robots' TRUE current positions. That only holds when robot
 * position updates and orchestrator ticks are interleaved in lockstep —
 * exactly what the FakeAdapter-driven tests do (`adapter.tick()` then
 * `orchestrator.tickOnce()`, one full step at a time). A real adapter
 * (vda5050/seer-tcp) driven by `start()`'s wall-clock `setInterval` has no
 * such guarantee: telemetry can arrive at any cadence relative to
 * `tickMs`, so a robot's reported position may already be multiple cells
 * stale (or ahead) by the time `runRouting()` reads it, which the current
 * "claim just [current, next]" reservation gate does not protect against.
 * Do not rely on the collision invariant for a real-adapter deployment
 * until proper horizon-gating (see `opts.horizon`) lands — tracked as a
 * follow-up for Task 11/12.
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

  submitOrder(pickupNode: string, dropNode: string): TransportOrder {
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
        const rt = this.robots.get(e.state.id);
        if (rt) {
          rt.state = e.state;
        } else {
          this.robots.set(e.state.id, {
            state: e.state,
            online: true,
            offlineHandled: false,
            quarantined: false,
          });
        }
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
      case "missionProgress":
        // Informational; position/status bookkeeping arrives via the
        // accompanying "state" heartbeat event.
        break;
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
      rt.leg = undefined;
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
    // fully processed before this robot's LAST KNOWN node (rt.currentNodeId,
    // as of resolveCurrentNodes() this tick) has actually caught up to the
    // leg's goal node — e.g. Vda5050Adapter only ever releases one more base
    // node per tick (see its sendMission doc comment), so a fast-moving AGV
    // can drain its currently-released path and report the VDA order
    // "done" before the orchestrator has appended/sent the next extension.
    // Only intercept when the CURRENT leg genuinely matches this missionId
    // (rt.leg.missionId === missionId) — if it doesn't match at all (no
    // leg, or a different leg/order entirely), that's the pre-existing
    // "stale report" case already handled below via book.transition()'s
    // own try/catch, and must NOT be touched here.
    if (rt.leg && rt.leg.missionId === missionId && rt.currentNodeId !== rt.leg.goalNode) {
      this.alarms.push(
        `t=${this.tickCount} premature missionDone from robot ${robotId} for order ${orderId} ` +
          `(leg=${leg}, at=${String(rt.currentNodeId)}, goal=${rt.leg.goalNode}) — cancelling and requeueing`
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
      rt.leg = undefined;
      return;
    }

    if (leg === "pick") {
      try {
        this.book.transition(orderId, "underway", "pickup complete");
      } catch {
        return; // stale/duplicate event for an order no longer in this state
      }
      rt.leg = {
        orderId,
        phase: "drop",
        goalNode: order.dropNode,
        missionId: `${orderId}:drop`,
        nodeIds: [], // seeded once this tick's current node is resolved
        sent: false,
      };
    } else {
      try {
        this.book.transition(orderId, "completed", "drop complete");
      } catch {
        return;
      }
      const cycleMs = this.nowMs() - Date.parse(order.createdAt);
      this.cycleTimes.push(cycleMs);
      this.completions++;
      rt.leg = undefined;
    }
  }

  private handleMissionFailed(robotId: RobotId, missionId: string, reason: string): void {
    const rt = this.robots.get(robotId);
    if (!rt) return;
    const parsed = parseMissionId(missionId);
    if (!parsed) {
      // Can't even tell which order this was for; just stop this robot
      // driving anything further and log it.
      rt.leg = undefined;
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
    rt.leg = undefined;
    this.alarms.push(`t=${this.tickCount} mission failed for robot ${robotId}: ${reason}`);
  }

  private resolveCurrentNodes(): void {
    for (const [id, rt] of this.robots) {
      const key = cellKey(rt.state.pos);
      const nodeId = this.posToNode.get(key);

      if (nodeId === undefined) {
        rt.currentNodeId = undefined;
        if (!rt.quarantined) {
          rt.quarantined = true;
          rt.state.status = "ERROR";
          this.alarms.push(
            `t=${this.tickCount} robot ${id} at unresolvable position ${key} — quarantined`
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
          rt.leg = undefined;
          // Best-effort: stop it executing whatever stale mission it still
          // thinks it has, so it doesn't quietly finish that mission later
          // (feeding the same stale-report class of bug the C1 guard
          // handles) and so a reused mission id on un-quarantine doesn't
          // hit the adapter's non-prefix-extension rejection.
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
      this.reservations.release(id, key);
      if (rt.leg && rt.leg.nodeIds.length === 0) {
        rt.leg.nodeIds = [nodeId];
      }
    }
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
      rt.leg = undefined;
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
      rt.leg = {
        orderId: order.id,
        phase: "pick",
        goalNode: order.pickupNode,
        missionId: `${order.id}:pick`,
        nodeIds: [rt.currentNodeId],
        sent: false,
      };
    }
  }

  /**
   * LOCKSTEP PRECONDITION: the zero-collision guarantee below rests
   * entirely on `this.router.step()` being called once per tick over every
   * robot's TRUE current position, with robot movement and orchestrator
   * ticks interleaved one-for-one (see the class-level doc comment). Under
   * a wall-clock `start()` timer against a real adapter, that assumption
   * does not automatically hold — flagged as a Task 11/12 follow-up.
   */
  private runRouting(): void {
    const agents: Agent[] = [];
    for (const [id, rt] of this.robots) {
      if (rt.quarantined || rt.currentNodeId === undefined) continue;
      const goal = rt.leg ? rt.leg.goalNode : rt.currentNodeId;
      agents.push({ id, at: rt.currentNodeId, goal, priority: 0 });
    }
    if (agents.length === 0) return;

    const moves = this.router.step(agents);

    for (const [id, rt] of this.robots) {
      if (!rt.leg || rt.currentNodeId === undefined) continue;
      const leg = rt.leg;
      const lastNode = leg.nodeIds[leg.nodeIds.length - 1];
      let changed = false;

      if (lastNode !== leg.goalNode) {
        const nextNode = moves.get(id) ?? rt.currentNodeId;
        leg.nodeIds.push(nextNode);
        changed = true;
      }

      if (!leg.sent || changed) {
        const currentCell = cellKey(this.map.node(rt.currentNodeId).pos);
        const aheadNode = leg.nodeIds[leg.nodeIds.length - 1];
        const aheadCell = cellKey(this.map.node(aheadNode).pos);
        const claimCells: CellKey[] =
          currentCell === aheadCell ? [currentCell] : [currentCell, aheadCell];

        const granted = this.reservations.claim(id, claimCells);
        if (granted.length < claimCells.length) {
          // v1 simplification: reservation contention is logged as a safety-net
          // alarm but does not block sending the mission — PIBT's step() call
          // above already guarantees this tick's moves are collision-free.
          this.alarms.push(
            `t=${this.tickCount} contention: robot ${id} could not claim ${aheadCell} (owner=${String(this.reservations.owner(aheadCell))})`
          );
        }

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
