import { Container, Graphics, Text } from "pixi.js";
import type { Application, Ticker } from "pixi.js";
import type { StateFrame } from "../types";
import { CELL, gridToPx } from "./coords";

/** Raw shape returned by `GET /map` — untyped on the server side, so kept minimal here. */
export interface RawMapNode {
  id: string;
  pos: { x: number; y: number };
}

export interface RawMapEdge {
  from: string;
  to: string;
}

export interface RawMapLike {
  nodes: RawMapNode[];
  edges: RawMapEdge[];
}

/** Status ring colors, per the task brief. */
const STATUS_COLORS: Record<string, number> = {
  IDLE: 0x9ca3af,
  EXECUTING: 0x4f46e5, // brand cobalt
  CHARGING: 0x22c55e,
  ERROR: 0xef4444,
  UNKNOWN: 0xf59e0b,
};

const BODY_COLOR = 0x4f46e5; // brand cobalt
const BODY_WIDTH = 30;
const BODY_HEIGHT = 18;
const BODY_RADIUS = 5;
const RING_RADIUS = 22;
const HEADING_LEN = 20;
const LABEL_COLOR = 0xe6e9f0;

// Fraction of the remaining distance to target closed per *second* of ticker
// time (frame-rate independent — see onTick below).
const LERP_RATE_PER_SEC = 10;

interface RobotVisual {
  container: Container;
  body: Graphics;
  ring: Graphics;
  glow: Graphics;
  heading: Graphics;
  batteryArc: Graphics;
  label: Text;
  target: { x: number; y: number };
  /** True once the container has been snapped to a first known position. */
  initialized: boolean;
}

export interface RendererOptions {
  /** Fired when a robot container is clicked/tapped. */
  onRobotClick?: (id: string) => void;
}

export interface Renderer {
  /** Root display container — mount this into the pan/zoom viewport. */
  readonly view: Container;
  /** Apply a new state frame: creates/updates/removes per-robot visuals. */
  update(frame: StateFrame, selectedRobotId?: string): void;
  /** Detach from the app ticker and free all display objects. */
  destroy(): void;
}

/** Pixel-space bounding box of a raw map, padded by `paddingCells` grid cells. */
export function mapBoundsPx(
  mapJson: RawMapLike,
  paddingCells = 2,
): { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number } {
  if (mapJson.nodes.length === 0) {
    const size = CELL * 10;
    return { minX: 0, minY: 0, maxX: size, maxY: size, width: size, height: size };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of mapJson.nodes) {
    const p = gridToPx(node.pos);
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }

  const pad = CELL * paddingCells;
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function drawStaticLayer(g: Graphics, mapJson: RawMapLike): void {
  g.clear();

  const nodePx = new Map<string, { x: number; y: number }>();
  for (const node of mapJson.nodes) {
    nodePx.set(node.id, gridToPx(node.pos));
  }

  const bounds = mapBoundsPx(mapJson);

  // Subtle background grid.
  const gridMinX = Math.floor(bounds.minX / CELL) * CELL;
  const gridMaxX = Math.ceil(bounds.maxX / CELL) * CELL;
  const gridMinY = Math.floor(bounds.minY / CELL) * CELL;
  const gridMaxY = Math.ceil(bounds.maxY / CELL) * CELL;
  for (let x = gridMinX; x <= gridMaxX; x += CELL) {
    g.moveTo(x, gridMinY).lineTo(x, gridMaxY);
  }
  for (let y = gridMinY; y <= gridMaxY; y += CELL) {
    g.moveTo(gridMinX, y).lineTo(gridMaxX, y);
  }
  g.stroke({ width: 1, color: 0xffffff, alpha: 0.04 });

  // Edges.
  for (const edge of mapJson.edges) {
    const from = nodePx.get(edge.from);
    const to = nodePx.get(edge.to);
    if (!from || !to) continue;
    g.moveTo(from.x, from.y).lineTo(to.x, to.y);
  }
  g.stroke({ width: 1.5, color: BODY_COLOR, alpha: 0.25 });

  // Node dots.
  for (const p of nodePx.values()) {
    g.circle(p.x, p.y, 3);
  }
  g.fill({ color: 0xffffff, alpha: 0.3 });
}

function drawBody(g: Graphics): void {
  g.clear();
  g.roundRect(-BODY_WIDTH / 2, -BODY_HEIGHT / 2, BODY_WIDTH, BODY_HEIGHT, BODY_RADIUS);
  g.fill(BODY_COLOR);
}

function drawHeading(g: Graphics, theta: number): void {
  g.clear();
  const x2 = Math.cos(theta) * HEADING_LEN;
  const y2 = Math.sin(theta) * HEADING_LEN;
  g.moveTo(0, 0).lineTo(x2, y2);
  g.stroke({ width: 3, color: 0xffffff, alpha: 0.9 });
}

function drawRing(g: Graphics, color: number, selected: boolean): void {
  g.clear();
  g.circle(0, 0, RING_RADIUS);
  g.stroke({ width: selected ? 3.5 : 2, color, alpha: selected ? 1 : 0.85 });
}

function drawGlow(g: Graphics, color: number, selected: boolean): void {
  g.clear();
  if (!selected) return;
  g.circle(0, 0, RING_RADIUS + 5);
  g.stroke({ width: 7, color, alpha: 0.35 });
}

function drawBattery(g: Graphics, battery: number): void {
  g.clear();
  const clamped = Math.max(0, Math.min(1, battery));
  const color = clamped > 0.5 ? 0x22c55e : clamped > 0.2 ? 0xf59e0b : 0xef4444;
  const start = -Math.PI / 2;
  const end = start + clamped * Math.PI * 2;
  if (clamped <= 0) return;
  g.arc(0, 0, RING_RADIUS - 6, start, end);
  g.stroke({ width: 2.5, color });
}

export function createRenderer(
  app: Application,
  mapJson: RawMapLike,
  options: RendererOptions = {},
): Renderer {
  const view = new Container();
  view.label = "map-root";

  const staticLayer = new Graphics();
  drawStaticLayer(staticLayer, mapJson);
  view.addChild(staticLayer);

  const robotLayer = new Container();
  robotLayer.label = "robots";
  view.addChild(robotLayer);

  const robots = new Map<string, RobotVisual>();

  function createRobotVisual(id: string): RobotVisual {
    const container = new Container();
    container.eventMode = "static";
    container.cursor = "pointer";
    container.on("pointertap", () => options.onRobotClick?.(id));

    const glow = new Graphics();
    const ring = new Graphics();
    const batteryArc = new Graphics();
    const body = new Graphics();
    const heading = new Graphics();
    const label = new Text({
      text: id,
      style: {
        fontFamily: "JetBrains Mono",
        fontSize: 11,
        fill: LABEL_COLOR,
      },
    });
    label.anchor.set(0.5, 0);
    label.y = RING_RADIUS + 4;

    container.addChild(glow, ring, batteryArc, body, heading, label);
    robotLayer.addChild(container);

    return {
      container,
      body,
      ring,
      glow,
      heading,
      batteryArc,
      label,
      target: { x: 0, y: 0 },
      initialized: false,
    };
  }

  function update(frame: StateFrame, selectedRobotId?: string): void {
    const seen = new Set<string>();

    for (const robot of frame.robots) {
      seen.add(robot.id);
      let rv = robots.get(robot.id);
      if (!rv) {
        rv = createRobotVisual(robot.id);
        robots.set(robot.id, rv);
      }

      const target = gridToPx(robot.pos);
      rv.target.x = target.x;
      rv.target.y = target.y;
      if (!rv.initialized) {
        // Snap to the first known position instead of lerping in from (0,0).
        rv.container.x = target.x;
        rv.container.y = target.y;
        rv.initialized = true;
      }

      const selected = robot.id === selectedRobotId;
      const statusColor = STATUS_COLORS[robot.status] ?? STATUS_COLORS.UNKNOWN;

      drawBody(rv.body);
      drawHeading(rv.heading, robot.theta);
      drawRing(rv.ring, selected ? 0xffffff : statusColor, selected);
      drawGlow(rv.glow, statusColor, selected);
      drawBattery(rv.batteryArc, robot.battery);
      if (rv.label.text !== robot.id) rv.label.text = robot.id;
    }

    // Robots that dropped out of this frame are no longer tracked.
    for (const [id, rv] of robots) {
      if (seen.has(id)) continue;
      robotLayer.removeChild(rv.container);
      rv.container.destroy({ children: true });
      robots.delete(id);
    }
  }

  function onTick(ticker: Ticker): void {
    if (robots.size === 0) return;
    // Frame-rate independent exponential lerp: closes a fixed fraction of
    // the remaining distance per second, regardless of the actual FPS.
    const t = 1 - Math.exp(-LERP_RATE_PER_SEC * (ticker.deltaMS / 1000));
    for (const rv of robots.values()) {
      rv.container.x += (rv.target.x - rv.container.x) * t;
      rv.container.y += (rv.target.y - rv.container.y) * t;
    }
  }
  app.ticker.add(onTick);

  function destroy(): void {
    app.ticker.remove(onTick);
    for (const rv of robots.values()) {
      rv.container.destroy({ children: true });
    }
    robots.clear();
    view.destroy({ children: true });
  }

  return { view, update, destroy };
}
