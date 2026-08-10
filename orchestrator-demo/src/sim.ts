// Tez Robotics — warehouse fleet simulation core.
// Grid world, A* routing, greedy cost-based dispatcher, cell-reservation conflict resolution, battery model.

export const GRID_W = 46;
export const GRID_H = 26;
export const CELL_METERS = 1.5;

export const enum Cell {
  Floor = 0,
  Rack = 1,
  Station = 2,
  Charger = 3,
}

export interface Point { x: number; y: number; }

export type RobotState = "idle" | "toPick" | "picking" | "toDrop" | "dropping" | "toCharge" | "charging";

export interface Robot {
  id: number;
  pos: Point;          // current cell
  fx: number; fy: number; // smooth render position
  path: Point[];
  state: RobotState;
  battery: number;     // 0..100
  order: Order | null;
  waitTicks: number;
  distanceCells: number;
  blockedTicks: number;
}

export type OrderStatus = "new" | "assigned" | "done";

export interface Order {
  id: string;
  rack: Point;      // rack cell
  pick: Point;      // walkable cell adjacent to rack
  station: Point;   // drop station approach cell
  stationIdx: number;
  status: OrderStatus;
  createdAt: number; // sim seconds
  doneAt: number;
}

export interface Metrics {
  done: number;
  perHour: number;
  avgCycleSec: number;
  utilization: number;
  distanceMeters: number;
  queue: number;
  walkSavedMeters: number;
}

// ---------- Layout ----------

export const grid: Cell[][] = [];
export const stations: Point[] = [];
export const chargers: Point[] = [];
const rackCells: Point[] = [];

export function buildLayout() {
  for (let y = 0; y < GRID_H; y++) {
    grid[y] = [];
    for (let x = 0; x < GRID_W; x++) grid[y][x] = Cell.Floor;
  }
  // Rack blocks: pairs of columns with 2-wide aisles, horizontal cross-aisle in the middle.
  const midY = Math.floor(GRID_H / 2);
  for (let x = 6; x <= 37; x += 4) {
    for (const dx of [0, 1]) {
      for (let y = 3; y <= GRID_H - 5; y++) {
        if (y === midY || y === midY + 1) continue; // cross-aisle
        grid[y][x + dx] = Cell.Rack;
        rackCells.push({ x: x + dx, y });
      }
    }
  }
  // Packing stations on the right edge.
  const stYs = [4, 9, 14, 19];
  for (const y of stYs) {
    grid[y][GRID_W - 2] = Cell.Station;
    stations.push({ x: GRID_W - 2, y });
  }
  // Chargers bottom-left.
  for (let i = 0; i < 6; i++) {
    grid[GRID_H - 2][2 + i] = Cell.Charger;
    chargers.push({ x: 2 + i, y: GRID_H - 2 });
  }
}

export function isWalkable(x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) return false;
  return grid[y][x] !== Cell.Rack;
}

function adjacentWalkable(p: Point): Point | null {
  const dirs = [
    { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 },
  ];
  for (const d of dirs) {
    const nx = p.x + d.x, ny = p.y + d.y;
    if (isWalkable(nx, ny) && grid[ny][nx] === Cell.Floor) return { x: nx, y: ny };
  }
  return null;
}

// ---------- A* ----------

function key(p: Point): number { return p.y * GRID_W + p.x; }

export function astar(start: Point, goal: Point): Point[] {
  if (start.x === goal.x && start.y === goal.y) return [];
  const open: Point[] = [start];
  const came = new Map<number, number>();
  const g = new Map<number, number>();
  g.set(key(start), 0);
  const h = (p: Point) => Math.abs(p.x - goal.x) + Math.abs(p.y - goal.y);
  const f = new Map<number, number>();
  f.set(key(start), h(start));

  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) {
      if ((f.get(key(open[i])) ?? 1e9) < (f.get(key(open[bi])) ?? 1e9)) bi = i;
    }
    const cur = open.splice(bi, 1)[0];
    if (cur.x === goal.x && cur.y === goal.y) {
      const path: Point[] = [cur];
      let k = key(cur);
      while (came.has(k)) {
        k = came.get(k)!;
        path.push({ x: k % GRID_W, y: Math.floor(k / GRID_W) });
      }
      path.pop(); // drop start
      return path.reverse();
    }
    for (const d of [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }]) {
      const nx = cur.x + d.x, ny = cur.y + d.y;
      const walk = isWalkable(nx, ny) || (nx === goal.x && ny === goal.y);
      if (!walk) continue;
      const nk = ny * GRID_W + nx;
      const ng = (g.get(key(cur)) ?? 1e9) + 1;
      if (ng < (g.get(nk) ?? 1e9)) {
        came.set(nk, key(cur));
        g.set(nk, ng);
        f.set(nk, ng + Math.abs(nx - goal.x) + Math.abs(ny - goal.y));
        if (!open.some((p) => p.x === nx && p.y === ny)) open.push({ x: nx, y: ny });
      }
    }
  }
  return [];
}

// ---------- Simulation ----------

export class Sim {
  robots: Robot[] = [];
  orders: Order[] = [];
  feed: Order[] = [];
  simTime = 0; // seconds
  orderRate = 4; // orders per minute
  private orderTimer = 0;
  private orderSeq = 1;
  private doneCount = 0;
  private cycleSum = 0;
  private utilEma = 0;
  private distanceCells = 0;

  constructor(robotCount: number) {
    buildLayout();
    this.setRobotCount(robotCount);
  }

  setRobotCount(n: number) {
    const spawn: Point[] = [];
    for (let y = 1; y < GRID_H - 1 && spawn.length < n; y++) {
      for (let x = 1; x < 5 && spawn.length < n; x++) {
        if (grid[y][x] === Cell.Floor) spawn.push({ x, y });
      }
    }
    if (n < this.robots.length) {
      this.robots = this.robots.slice(0, n);
    } else {
      for (let i = this.robots.length; i < n; i++) {
        const p = spawn[i % spawn.length];
        this.robots.push({
          id: i + 1,
          pos: { ...p }, fx: p.x, fy: p.y,
          path: [], state: "idle", battery: 60 + Math.random() * 40,
          order: null, waitTicks: 0, distanceCells: 0, blockedTicks: 0,
        });
      }
    }
  }

  private spawnOrder() {
    const rack = rackCells[Math.floor(Math.random() * rackCells.length)];
    const pick = adjacentWalkable(rack);
    if (!pick) return;
    const stationIdx = Math.floor(Math.random() * stations.length);
    const st = stations[stationIdx];
    const approach = { x: st.x - 1, y: st.y };
    const o: Order = {
      id: `ORD-${String(this.orderSeq++).padStart(4, "0")}`,
      rack, pick, station: approach, stationIdx,
      status: "new", createdAt: this.simTime, doneAt: 0,
    };
    this.orders.push(o);
    this.feed.unshift(o);
    if (this.feed.length > 8) this.feed.pop();
  }

  private dispatch() {
    const queue = this.orders.filter((o) => o.status === "new");
    if (!queue.length) return;
    const idle = this.robots.filter((r) => r.state === "idle" && r.battery > 30);
    for (const o of queue) {
      if (!idle.length) break;
      // cost-based greedy: nearest idle robot by manhattan distance
      let best = 0;
      let bestCost = 1e9;
      for (let i = 0; i < idle.length; i++) {
        const c = Math.abs(idle[i].pos.x - o.pick.x) + Math.abs(idle[i].pos.y - o.pick.y);
        if (c < bestCost) { bestCost = c; best = i; }
      }
      const robot = idle.splice(best, 1)[0];
      const path = astar(robot.pos, o.pick);
      if (!path.length && (robot.pos.x !== o.pick.x || robot.pos.y !== o.pick.y)) continue;
      robot.order = o;
      robot.path = path;
      robot.state = "toPick";
      o.status = "assigned";
    }
  }

  /** One sim step of dt seconds (dt small). Robot speed: 2 cells/sec. */
  step(dt: number) {
    this.simTime += dt;
    this.orderTimer += dt;
    const interval = 60 / this.orderRate;
    while (this.orderTimer >= interval) {
      this.orderTimer -= interval;
      this.spawnOrder();
    }
    this.dispatch();

    const occupied = new Set<number>();
    for (const r of this.robots) occupied.add(key(r.pos));

    const speed = 2; // cells per sim second
    for (const r of this.robots) {
      // battery
      if (r.state !== "charging") r.battery = Math.max(0, r.battery - dt * 0.04);
      if (r.state === "idle" && r.battery <= 30) {
        const ch = chargers[r.id % chargers.length];
        r.path = astar(r.pos, ch);
        r.state = "toCharge";
      }
      if (r.state === "charging") {
        r.battery = Math.min(100, r.battery + dt * 4);
        if (r.battery >= 95) r.state = "idle";
        continue;
      }
      if (r.state === "picking" || r.state === "dropping") {
        r.waitTicks -= dt;
        if (r.waitTicks <= 0) {
          if (r.state === "picking") {
            r.path = astar(r.pos, r.order!.station);
            r.state = "toDrop";
          } else {
            const o = r.order!;
            o.status = "done";
            o.doneAt = this.simTime;
            this.doneCount++;
            this.cycleSum += o.doneAt - o.createdAt;
            r.order = null;
            r.state = "idle";
          }
        }
        continue;
      }
      if (!r.path.length) {
        if (r.state === "toPick") { r.state = "picking"; r.waitTicks = 2.0; }
        else if (r.state === "toDrop") { r.state = "dropping"; r.waitTicks = 2.0; }
        else if (r.state === "toCharge") { r.state = "charging"; }
        continue;
      }
      // move toward next path cell with cell reservation
      const next = r.path[0];
      const nk = key(next);
      if (occupied.has(nk)) {
        r.blockedTicks += dt;
        if (r.blockedTicks > 1.5) {
          // repath around the blocker
          const goal = r.path[r.path.length - 1];
          r.path = astar(r.pos, goal);
          r.blockedTicks = 0;
        }
        continue;
      }
      r.blockedTicks = 0;
      const dist = speed * dt;
      const dx = next.x - r.fx, dy = next.y - r.fy;
      const len = Math.hypot(dx, dy);
      if (len <= dist) {
        occupied.delete(key(r.pos));
        r.fx = next.x; r.fy = next.y;
        r.pos = { ...next };
        occupied.add(nk);
        r.path.shift();
        r.distanceCells += 1;
        this.distanceCells += 1;
      } else {
        r.fx += (dx / len) * dist;
        r.fy += (dy / len) * dist;
      }
    }

    // utilization EMA
    const busy = this.robots.filter((r) => r.state !== "idle" && r.state !== "charging").length;
    const u = this.robots.length ? busy / this.robots.length : 0;
    this.utilEma = this.utilEma * 0.99 + u * 0.01;
  }

  metrics(): Metrics {
    const hours = this.simTime / 3600;
    const dist = this.distanceCells * CELL_METERS;
    return {
      done: this.doneCount,
      perHour: hours > 0 ? Math.round(this.doneCount / hours) : 0,
      avgCycleSec: this.doneCount ? Math.round(this.cycleSum / this.doneCount) : 0,
      utilization: Math.round(this.utilEma * 100),
      distanceMeters: Math.round(dist),
      queue: this.orders.filter((o) => o.status === "new").length,
      walkSavedMeters: Math.round(dist),
    };
  }
}
