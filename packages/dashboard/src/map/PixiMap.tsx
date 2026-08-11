import { useEffect, useRef, useState } from "react";
import { Application } from "pixi.js";
import { Viewport } from "pixi-viewport";
import { fleetStore } from "../store";
import { createRenderer, mapBoundsPx } from "./renderer";
import type { Renderer, RawMapLike } from "./renderer";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const FIT_PADDING_PX = 48;

/**
 * Scale + center the viewport so `bounds` (world px) fits inside a
 * `screenWidth`x`screenHeight` viewport with `FIT_PADDING_PX` of breathing
 * room on every side, clamped to [MIN_ZOOM, MAX_ZOOM]. Used both on initial
 * load and on container resize (as long as the user hasn't taken the
 * camera themselves — see `userInteracted` in the effect below).
 */
function fitToBounds(
  viewport: Viewport,
  bounds: { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number },
  screenWidth: number,
  screenHeight: number,
): void {
  const availableWidth = Math.max(1, screenWidth - FIT_PADDING_PX * 2);
  const availableHeight = Math.max(1, screenHeight - FIT_PADDING_PX * 2);
  const rawScale = Math.min(availableWidth / bounds.width, availableHeight / bounds.height);
  const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, rawScale));
  viewport.setZoom(scale, false);
  viewport.moveCenter((bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2);
}

/**
 * Live fleet map. Pixi v8 canvas + pixi-viewport pan/zoom, driven directly
 * by `fleetStore.subscribe` (not React state/props) so a ~10Hz WS frame
 * never triggers a React re-render — only the imperative Pixi scene graph
 * updates, via `Renderer.update` (see ./renderer.ts).
 */
export default function PixiMap() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;
    let app: Application | null = null;
    let viewport: Viewport | null = null;
    let renderer: Renderer | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let unsubscribe: (() => void) | null = null;
    // Once the user has dragged/wheeled/pinched, a ResizeObserver-driven
    // refit would fight their camera — stop auto-fitting after that point.
    let userInteracted = false;
    let onWheel: (() => void) | null = null;

    // Single owner of teardown. `setup()` (post-fetch) and the effect
    // cleanup can both race to destroy the same Pixi Application — whoever
    // gets here first wins, the other is a no-op. This is safe *without*
    // locking because JS is single-threaded: everything between two
    // `await` points runs atomically, so there is no interleaving where
    // both branches see `destroyed === false` at once.
    let destroyed = false;
    function destroyEverything(): void {
      if (destroyed) return;
      destroyed = true;
      resizeObserver?.disconnect();
      unsubscribe?.();
      if (onWheel) host?.removeEventListener("wheel", onWheel);
      renderer?.destroy();
      viewport?.destroy();
      app?.destroy(true, { children: true });
      app = null;
      viewport = null;
      renderer = null;
      resizeObserver = null;
      unsubscribe = null;
    }

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
      // (React StrictMode double-invokes effects in dev). `app` (the outer
      // ref `destroyEverything` owns) was never assigned yet, so cleanup's
      // `destroyEverything()` couldn't have touched this instance — destroy
      // it directly here, once init() has actually resolved (destroying
      // before init() resolves is unsafe: the renderer isn't attached yet).
      if (cancelled) {
        application.destroy(true, { children: true });
        return;
      }
      app = application;
      host!.appendChild(application.canvas);

      const mapRes = await fetch("/map");
      if (!mapRes.ok) {
        throw new Error(`GET /map failed: ${mapRes.status} ${mapRes.statusText}`);
      }
      const mapJson = (await mapRes.json()) as RawMapLike;

      // By now `app` above WAS assigned before this await, so if the effect
      // was cleaned up while the fetch was in flight, cleanup's
      // `destroyEverything()` already ran and destroyed it. Route through
      // the same guarded function instead of destroying `application`
      // again directly — it no-ops when cleanup got there first, and
      // still destroys when this async continuation is the first (and
      // only) one to observe `cancelled`.
      if (cancelled) {
        destroyEverything();
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

      const markUserInteracted = (): void => {
        userInteracted = true;
      };
      vp.on("drag-start", markUserInteracted);
      vp.on("pinch-start", markUserInteracted);
      onWheel = markUserInteracted;
      host!.addEventListener("wheel", onWheel, { passive: true });

      fitToBounds(vp, bounds, width, height);

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
        if (!userInteracted) fitToBounds(vp, bounds, w, h);
      });
      resizeObserver.observe(host!);
    }

    setup().catch((err: unknown) => {
      // Covers: WebGL/canvas unavailable, non-2xx /map, malformed JSON, or
      // any other failure partway through setup. Tear down whatever
      // partial state was created (idempotent — safe even if cleanup
      // already ran) so nothing leaks, then surface a fallback instead of
      // leaving the Cockpit tab silently blank.
      destroyEverything();
      if (cancelled) return;
      console.error("[PixiMap] failed to initialize live map", err);
      setError(err instanceof Error ? err.message : String(err));
    });

    return () => {
      cancelled = true;
      destroyEverything();
    };
  }, []);

  if (error) {
    return (
      <div className="flex h-full w-full items-center justify-center p-4 text-center text-sm text-[var(--text)]/60">
        Failed to load the live map: {error}
      </div>
    );
  }

  return <div ref={hostRef} className="h-full w-full" />;
}
