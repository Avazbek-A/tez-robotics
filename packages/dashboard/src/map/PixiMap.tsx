import { useEffect, useRef } from "react";
import { Application } from "pixi.js";
import { Viewport } from "pixi-viewport";
import { fleetStore } from "../store";
import { createRenderer, mapBoundsPx } from "./renderer";
import type { Renderer, RawMapLike } from "./renderer";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

/**
 * Live fleet map. Pixi v8 canvas + pixi-viewport pan/zoom, driven directly
 * by `fleetStore.subscribe` (not React state/props) so a ~10Hz WS frame
 * never triggers a React re-render — only the imperative Pixi scene graph
 * updates, via `Renderer.update` (see ./renderer.ts).
 */
export default function PixiMap() {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;
    let app: Application | null = null;
    let viewport: Viewport | null = null;
    let renderer: Renderer | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let unsubscribe: (() => void) | null = null;

    async function setup(): Promise<void> {
      const width = host!.clientWidth || 800;
      const height = host!.clientHeight || 600;

      const application = new Application();
      await application.init({
        width,
        height,
        backgroundAlpha: 0,
        antialias: true,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
      });

      // The effect may have been cleaned up while `init` was in flight
      // (React StrictMode double-invokes effects in dev).
      if (cancelled) {
        application.destroy(true, { children: true });
        return;
      }
      app = application;
      host!.appendChild(application.canvas);

      const mapRes = await fetch("/map");
      const mapJson = (await mapRes.json()) as RawMapLike;

      if (cancelled) {
        application.destroy(true, { children: true });
        return;
      }

      const bounds = mapBoundsPx(mapJson);

      const vp = new Viewport({
        screenWidth: width,
        screenHeight: height,
        worldWidth: bounds.width,
        worldHeight: bounds.height,
        events: application.renderer.events,
      });
      viewport = vp;
      application.stage.addChild(vp);

      vp.drag().pinch().wheel();
      vp.clampZoom({ minScale: MIN_ZOOM, maxScale: MAX_ZOOM });
      vp.clamp({
        left: bounds.minX,
        top: bounds.minY,
        right: bounds.maxX,
        bottom: bounds.maxY,
        underflow: "center",
      });
      vp.moveCenter((bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2);

      const r = createRenderer(application, mapJson, {
        onRobotClick: (id) => fleetStore.getState().selectRobot(id),
      });
      renderer = r;
      vp.addChild(r.view);

      // Paint whatever frame is already in the store (e.g. mounted mid-stream).
      const initial = fleetStore.getState();
      if (initial.frame) r.update(initial.frame, initial.selectedRobotId);

      unsubscribe = fleetStore.subscribe((state, prev) => {
        if (!state.frame) return;
        if (state.frame === prev.frame && state.selectedRobotId === prev.selectedRobotId) return;
        r.update(state.frame, state.selectedRobotId);
      });

      resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        const w = Math.max(1, Math.floor(entry.contentRect.width));
        const h = Math.max(1, Math.floor(entry.contentRect.height));
        application.renderer.resize(w, h);
        vp.resize(w, h, bounds.width, bounds.height);
      });
      resizeObserver.observe(host!);
    }

    void setup();

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      unsubscribe?.();
      renderer?.destroy();
      viewport?.destroy();
      app?.destroy(true, { children: true });
    };
  }, []);

  return <div ref={hostRef} className="h-full w-full" />;
}
