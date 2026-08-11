import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import type { System } from "./system.js";
import type { RobotState } from "@tez/shared";
import type { TransportOrder } from "@tez/core";

export interface WsRouteOpts extends FastifyPluginOptions {
  system: System;
}

/** Broadcast tick interval (ms). 10Hz = 1000/10. */
export const FRAME_MS = 100;

/** Keep only the most recent N alarms in a broadcast frame. */
const ALARMS_TAIL = 100;

export interface StateFrame {
  t: string; // ISO timestamp
  seq: number; // per-connection increasing
  degraded: boolean; // false in v1
  robots: RobotState[];
  orders: TransportOrder[];
  kpis: { ordersPerHour: number; avgCycleMs: number; utilization: number };
  alarms: string[]; // tail: last ALARMS_TAIL of orchestrator.getAlarms()
}

/**
 * Pure frame-assembly function: reads `system`'s current snapshot + alarms
 * and stamps it with `seq`/`t`. Exported so tests (and any future producer)
 * can build a frame without going through a live socket.
 */
export function makeFrame(system: System, seq: number): StateFrame {
  const { robots, orders, kpis } = system.orchestrator.snapshot();
  const alarms = system.orchestrator.getAlarms().slice(-ALARMS_TAIL);
  return {
    t: new Date().toISOString(),
    seq,
    degraded: false,
    robots,
    orders,
    kpis,
    alarms,
  };
}

/**
 * Fastify plugin registering `GET /ws/state`: a 10Hz batched state stream.
 *
 * One shared `setInterval` per server (not per socket) broadcasts a fresh
 * `makeFrame` to every connected socket; each connection gets a full frame
 * immediately on connect (seq=0), then the same ticking frame's seq keeps
 * increasing thereafter. The interval is unref'd (doesn't keep the process
 * alive on its own) and cleared via fastify's `onClose` hook.
 */
export async function wsRoutes(app: FastifyInstance, opts: WsRouteOpts): Promise<void> {
  const { system } = opts;

  await app.register(fastifyWebsocket);

  const sockets = new Set<WebSocket>();
  let seq = 0;

  const timer = setInterval(() => {
    seq += 1;
    const frame = makeFrame(system, seq);
    const payload = JSON.stringify(frame);
    for (const socket of sockets) {
      socket.send(payload);
    }
  }, FRAME_MS);
  timer.unref();

  app.addHook("onClose", (_instance, done) => {
    clearInterval(timer);
    done();
  });

  app.get("/ws/state", { websocket: true }, (socket) => {
    sockets.add(socket);
    socket.send(JSON.stringify(makeFrame(system, 0)));

    const cleanup = () => {
      sockets.delete(socket);
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });
}
