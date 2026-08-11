/**
 * Task 3 protocol spike: lock the exact `vda-5050-lib` (^1.7, actual 1.7.2)
 * API surface with a passing master-controller <-> virtual-AGV order
 * roundtrip test, run against an in-process aedes broker (no container
 * runtime available on this machine) started via `startDevBroker()` from
 * `@tez/robot-interface` (Task 2).
 *
 * ============================================================================
 * DEVIATIONS FROM THE BRIEF'S EXPECTED SHAPE (verified against
 * node_modules/.pnpm/vda-5050-lib@1.7.2/node_modules/vda-5050-lib/*.d.ts and
 * the package README, not guessed):
 * ============================================================================
 *
 * 1. `ClientOptions.vdaVersion` is REQUIRED (type `VdaVersion` = "1.1.0" |
 *    "2.0.0" | "2.1.0" | "3.0.0"). The brief's `opts` object omitted it
 *    entirely -> compile error. We use "2.0.0" per the trap note and the
 *    README's own examples, which all use "2.0.0" as the canonical minimal
 *    config. Both AgvController and MasterController MUST be given the SAME
 *    `interfaceName` and the SAME `vdaVersion` (or at least same major
 *    version) or their MQTT topics never align and the order silently never
 *    completes (see gotcha #2 below).
 *
 * 2. `AgvController`'s constructor is NOT `(agvId, opts, {}, { agvAdapterType,
 *    agvAdapterOptions })` as the brief wrote it. The real signature is FOUR
 *    separate positional arguments:
 *      `new AgvController(agvId: AgvId, clientOptions: ClientOptions,
 *         controllerOptions: AgvControllerOptions, adapterOptions: AgvAdapterOptions)`
 *    `agvAdapterType` (required, e.g. `VirtualAgvAdapter`) belongs on
 *    `controllerOptions` (3rd arg), and adapter-specific options (e.g.
 *    `initialPosition`) belong on a SEPARATE 4th arg, typed per-adapter as
 *    `VirtualAgvAdapterOptions` here -- there is no nested
 *    `agvAdapterOptions` property anywhere in the real types.
 *
 * 3. `MasterController`'s constructor is `(clientOptions: ClientOptions,
 *    controllerOptions: MasterControllerOptions)` -- this part matches the
 *    brief. `controllerOptions` may be `{}` (its only field, `targetAgvs`, is
 *    optional and defaults to `{}`, i.e. "all AGVs in this interface").
 *
 * 4. `OrderEventHandler.onOrderProcessed` is NOT `(err) => void` as the brief
 *    wrote it. The real signature is:
 *      `onOrderProcessed(withError: Error, byCancelation: boolean,
 *         active: boolean, context: OrderContext): void`
 *    - `withError` is `undefined` on success (not `null`).
 *    - `active` is `true` if the order still has pending horizon nodes/edges
 *      after all BASE nodes/edges are done; for our fully-released 2-node
 *      order it must be `false` once done -- we assert on this to prove real
 *      completion, not just "no error yet".
 *    - `byCancelation` must be `false` for a normal completion.
 *
 * 5. `Node`/`Edge`/`NodePosition` required-field shapes in the brief already
 *    match the real 2.1 types (which is what the top-level `Order`/`Node`/
 *    `Edge` exports resolve to, regardless of the runtime `vdaVersion`
 *    selected -- the TS types are NOT parameterized by `vdaVersion`; that
 *    option only affects wire-level major-version topic segment and runtime
 *    validation). No changes needed: `Node.actions` and `Edge.actions` are
 *    required arrays (may be empty `[]`), `released`/`sequenceId` required,
 *    `NodePosition.mapId/x/y` required, `theta` optional.
 *
 * 6. `VirtualAgvAdapterOptions.initialPosition` shape
 *    `{ mapId, x, y, theta, lastNodeId }` matches the brief exactly. Per the
 *    adapter's own doc comment, EVERY node beyond the first must specify
 *    `nodePosition` (already true here), and the AGV must start ON (within
 *    deviation range of) the first order node's position -- hence
 *    `initialPosition` mirrors node "n0"'s `nodePosition` and `lastNodeId`.
 *
 * ============================================================================
 * GOTCHAS (not API-shape mismatches, but behavior that cost debugging time):
 * ============================================================================
 *
 * - Both controllers must share the same `interfaceName` (and compatible
 *   `vdaVersion`) -- topics are built as
 *   `%interfaceName%/%majorVersion%/%manufacturer%/%serialNumber%/%topic%`.
 *   If they don't match, `assignOrder` still resolves (order is published
 *   fine) but `onOrderProcessed` never fires because the AGV never receives
 *   the order and the master never sees a matching State topic -- this looks
 *   exactly like a hang, not an error, so it burns the whole 20s timeout.
 * - No retained-message trap was hit in practice: the in-process aedes dev
 *   broker starts empty per test run and both controllers start (and thus
 *   subscribe) before `assignOrder` is called, so ordering is not an issue
 *   here. Worth re-checking against a real broker with persisted retained
 *   State topics from a previous run in later tasks.
 * - `AgvController.start()` must be awaited before `MasterController.start()`
 *   assigns anything, and `MasterController.start()` must be awaited before
 *   `assignOrder` -- both are async and connect over MQTT; skipping the
 *   await produces flaky "sometimes works" behavior, not a hard error.
 * - Teardown order matters less than expected in practice (`mc.stop()` then
 *   `agv.stop()` both being simple client disconnects), but we keep the
 *   brief's order (master, then AGV) for consistency with later tasks.
 *
 * No `packages/robot-interface/src/spike.ts` helper file was created: no
 * reusable non-test code emerged from this spike (the corrected snippet
 * below is the entire deliverable), so everything lives in this test file
 * per the task brief's guidance to skip the helper file when not needed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  MasterController,
  AgvController,
  VirtualAgvAdapter,
  type AgvId,
  type ClientOptions,
} from 'vda-5050-lib';
import { startDevBroker, type DevBrokerResult } from '../src/dev-broker.js';

describe('vda-5050-lib protocol spike: master <-> virtual AGV order roundtrip', () => {
  let devBroker: DevBrokerResult;
  let clientOptions: ClientOptions;
  let agv: AgvController;
  let mc: MasterController;

  const agvId: AgvId = { manufacturer: 'tez', serialNumber: 'sim-001' };

  beforeAll(async () => {
    // Force pure ephemeral ports (0) rather than relying on the default
    // 1883/9001 + EADDRINUSE-fallback: when this file runs alongside
    // broker.test.ts (which also calls startDevBroker() with defaults),
    // both processes race to bind the same default ports and the fallback
    // isn't atomic, causing spurious EADDRINUSE failures under `pnpm -r test`.
    // Requesting port 0 up front sidesteps the race entirely.
    devBroker = await startDevBroker({ port: 0, wsPort: 0 });
    clientOptions = {
      interfaceName: 'uagv',
      transport: { brokerUrl: devBroker.url },
      vdaVersion: '2.0.0',
    };
  });

  afterAll(async () => {
    await devBroker.close();
  });

  it(
    'virtual AGV completes a 2-node order',
    async () => {
      agv = new AgvController(
        agvId,
        clientOptions,
        { agvAdapterType: VirtualAgvAdapter },
        { initialPosition: { mapId: 'demo', x: 0, y: 0, theta: 0, lastNodeId: 'n0' } },
      );
      await agv.start();

      mc = new MasterController(clientOptions, {});
      await mc.start();

      const result = await new Promise<{ withError: unknown; byCancelation: boolean; active: boolean }>(
        (resolve) => {
          void mc.assignOrder(
            agvId,
            {
              orderId: 'o1',
              orderUpdateId: 0,
              nodes: [
                {
                  nodeId: 'n0',
                  sequenceId: 0,
                  released: true,
                  nodePosition: { x: 0, y: 0, mapId: 'demo' },
                  actions: [],
                },
                {
                  nodeId: 'n1',
                  sequenceId: 2,
                  released: true,
                  nodePosition: { x: 1, y: 0, mapId: 'demo' },
                  actions: [],
                },
              ],
              edges: [
                {
                  edgeId: 'e01',
                  sequenceId: 1,
                  released: true,
                  startNodeId: 'n0',
                  endNodeId: 'n1',
                  actions: [],
                },
              ],
            },
            {
              onOrderProcessed: (withError, byCancelation, active) => {
                resolve({ withError, byCancelation, active });
              },
            },
          );
        },
      );

      expect(result.withError).toBeUndefined();
      expect(result.byCancelation).toBe(false);
      expect(result.active).toBe(false);

      await mc.stop();
      await agv.stop();
    },
    20_000,
  );
});
