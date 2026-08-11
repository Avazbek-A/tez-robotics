import { cloneElement, isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useI18n } from "../src/i18n";
import { fleetStore, KPI_BUFFER_CAP } from "../src/store";
import { OrdersTab } from "../src/tabs/OrdersTab";
import { AnalyticsTab } from "../src/tabs/AnalyticsTab";
import type { StateFrame, TransportOrder } from "../src/types";

// recharts' `ResponsiveContainer` measures its DOM node via ResizeObserver
// to get pixel dimensions; happy-dom has no real layout engine, so it always
// measures 0x0 and recharts logs a "width(0) and height(0)" warning to
// stderr on every render. That's just test-environment noise — real
// browsers measure real dimensions fine — so it's stubbed out here to hand
// the wrapped chart a fixed, non-zero size directly instead of measuring,
// keeping CI/test output clean.
vi.mock("recharts", async () => {
  const actual = await vi.importActual<typeof import("recharts")>("recharts");
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) =>
      isValidElement(children)
        ? cloneElement(children, { width: 400, height: 200 } as Record<string, unknown>)
        : children,
  };
});

function makeOrder(overrides: Partial<TransportOrder> = {}): TransportOrder {
  return {
    id: "o1",
    pickupNode: "n1_1",
    dropNode: "n6_6",
    status: "queued",
    retries: 0,
    createdAt: new Date("2026-08-11T10:00:00Z").toISOString(),
    history: [],
    ...overrides,
  };
}

function makeFrame(orders: TransportOrder[]): StateFrame {
  return {
    t: new Date().toISOString(),
    seq: 1,
    degraded: false,
    robots: [],
    orders,
    kpis: { ordersPerHour: 5, avgCycleMs: 12000, utilization: 0.5 },
    alarms: [],
  };
}

const INITIAL_FLEET_STATE = {
  connection: "connecting" as const,
  frame: undefined,
  lastFrameAt: undefined,
  kpiBuffer: [],
  selectedRobotId: undefined,
};

beforeEach(() => {
  localStorage.clear();
  useI18n.setState({ lang: "en" });
  fleetStore.setState(INITIAL_FLEET_STATE);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OrdersTab", () => {
  it("filters rows by status chip", () => {
    fleetStore.getState().applyFrame(
      makeFrame([
        makeOrder({ id: "q-1", status: "queued" }),
        makeOrder({ id: "d-1", status: "dispatched" }),
        makeOrder({ id: "c-1", status: "completed" }),
      ]),
    );

    render(<OrdersTab />);

    expect(screen.getByTestId("orders-row-q-1")).toBeInTheDocument();
    expect(screen.getByTestId("orders-row-d-1")).toBeInTheDocument();
    expect(screen.getByTestId("orders-row-c-1")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("status-chip-completed"));

    expect(screen.queryByTestId("orders-row-q-1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("orders-row-d-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("orders-row-c-1")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("status-chip-all"));
    expect(screen.getByTestId("orders-row-q-1")).toBeInTheDocument();
  });

  it("filters rows by id search text", () => {
    fleetStore.getState().applyFrame(
      makeFrame([makeOrder({ id: "alpha-1" }), makeOrder({ id: "beta-2" })]),
    );

    render(<OrdersTab />);

    fireEvent.change(screen.getByPlaceholderText("Search orders"), {
      target: { value: "beta" },
    });

    expect(screen.queryByTestId("orders-row-alpha-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("orders-row-beta-2")).toBeInTheDocument();
  });

  it("combines status chip and search filters", () => {
    fleetStore.getState().applyFrame(
      makeFrame([
        makeOrder({ id: "alpha-1", status: "queued" }),
        makeOrder({ id: "alpha-2", status: "completed" }),
        makeOrder({ id: "beta-1", status: "queued" }),
      ]),
    );

    render(<OrdersTab />);

    fireEvent.click(screen.getByTestId("status-chip-queued"));
    fireEvent.change(screen.getByPlaceholderText("Search orders"), {
      target: { value: "alpha" },
    });

    expect(screen.getByTestId("orders-row-alpha-1")).toBeInTheDocument();
    expect(screen.queryByTestId("orders-row-alpha-2")).not.toBeInTheDocument();
    expect(screen.queryByTestId("orders-row-beta-1")).not.toBeInTheDocument();
  });

  it("expands a row to fetch and show its history timeline", async () => {
    const order = makeOrder({
      id: "o-hist",
      history: [{ at: "2026-08-11T10:00:00Z", from: "queued", to: "dispatched" }],
    });
    fleetStore.getState().applyFrame(makeFrame([order]));

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        orders: [
          {
            ...order,
            history: [
              { id: 1, order_id: "o-hist", at: "2026-08-11T10:00:00Z", status: "dispatched", robot_id: "r1", note: null },
            ],
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<OrdersTab />);

    fireEvent.click(screen.getByTestId("orders-row-o-hist"));

    await waitFor(() => {
      expect(screen.getByTestId("orders-history-o-hist")).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith("/orders?history=1");
    expect(within(screen.getByTestId("orders-history-o-hist")).getByText("r1")).toBeInTheDocument();
  });

  it("falls back to in-memory frame history when the fetch fails", async () => {
    const order = makeOrder({
      id: "o-offline",
      history: [{ at: "2026-08-11T10:00:00Z", from: "queued", to: "dispatched", reason: "auto-assign" }],
    });
    fleetStore.getState().applyFrame(makeFrame([order]));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    render(<OrdersTab />);
    fireEvent.click(screen.getByTestId("orders-row-o-offline"));

    await waitFor(() => {
      expect(screen.getByText("auto-assign")).toBeInTheDocument();
    });
  });

  it("does not refetch on re-expand at the same status, but does refetch after the order's status changed", async () => {
    const order = makeOrder({ id: "o-stale", status: "queued" });
    fleetStore.getState().applyFrame(makeFrame([order]));

    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => {
        const current = fleetStore.getState().frame?.orders[0] as TransportOrder;
        return {
          orders: [
            {
              ...current,
              history: [
                { id: 1, order_id: current.id, at: "2026-08-11T10:00:00Z", status: current.status, robot_id: null, note: null },
              ],
            },
          ],
        };
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<OrdersTab />);

    // Expand → first fetch.
    fireEvent.click(screen.getByTestId("orders-row-o-stale"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Collapse, then re-expand with no status change in between: cached,
    // no second fetch.
    fireEvent.click(screen.getByTestId("orders-row-o-stale"));
    expect(screen.queryByTestId("orders-history-o-stale")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("orders-row-o-stale"));
    await waitFor(() => expect(screen.getByTestId("orders-history-o-stale")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Collapse, the order progresses to a new status in a fresh frame, then
    // re-expand: the stale queued-status cache entry no longer applies, so
    // this must fetch again. The frame update is wrapped in `act` (and its
    // effect awaited via the badge text) so the row's closure has actually
    // picked up the new order object before the next click — otherwise the
    // click could fire against a stale pre-update render.
    fireEvent.click(screen.getByTestId("orders-row-o-stale"));
    act(() => {
      fleetStore.getState().applyFrame(
        makeFrame([{ ...order, status: "dispatched", robotId: "r1" as TransportOrder["robotId"] }]),
      );
    });
    await waitFor(() => {
      expect(within(screen.getByTestId("orders-row-o-stale")).getByText("Dispatched")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("orders-row-o-stale"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});

describe("AnalyticsTab", () => {
  it("renders three chart titles", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          live: { ordersPerHour: 0, avgCycleMs: 0, utilization: 0 },
          range: null,
          note: "persistence disabled",
        }),
      }),
    );

    render(<AnalyticsTab />);

    await waitFor(() => {
      expect(screen.getByText("persistence disabled")).toBeInTheDocument();
    });

    expect(screen.getByText("Orders / hour")).toBeInTheDocument();
    expect(screen.getByText("Fleet utilization")).toBeInTheDocument();
    expect(screen.getByText("Avg cycle, s")).toBeInTheDocument();
  });

  it("falls back to the live kpiBuffer sparkline when range is null", async () => {
    for (let i = 0; i < 3; i++) {
      fleetStore.getState().applyFrame(makeFrame([]));
    }
    expect(fleetStore.getState().kpiBuffer.length).toBeGreaterThan(0);
    expect(fleetStore.getState().kpiBuffer.length).toBeLessThanOrEqual(KPI_BUFFER_CAP);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ live: { ordersPerHour: 0, avgCycleMs: 0, utilization: 0 }, range: null }),
      }),
    );

    render(<AnalyticsTab />);

    await waitFor(() => {
      expect(screen.getByText("Orders / hour")).toBeInTheDocument();
    });
  });

  it("falls back to the live kpiBuffer sparkline when range is an empty array (persistence on, no rows yet)", async () => {
    for (let i = 0; i < 3; i++) {
      fleetStore.getState().applyFrame(makeFrame([]));
    }
    expect(fleetStore.getState().kpiBuffer.length).toBeGreaterThan(0);

    // `range: []` (as opposed to `range: null`) is what the server sends
    // when persistence is on but kpi_snapshots has no rows in range yet
    // (e.g. fresh boot). `[]` is truthy, so the buggy `if (range)` check
    // this test guards against would treat it as authoritative — empty —
    // data and render blank charts instead of falling back.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ live: { ordersPerHour: 0, avgCycleMs: 0, utilization: 0 }, range: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AnalyticsTab />);

    // The `range` state starts `null` (request in flight), and while it's
    // `null` *both* the buggy `if (range)` and the fixed
    // `if (range && range.length > 0)` fall through to the kpiBuffer
    // fallback identically — so asserting on ticks right after mount would
    // pass regardless of the bug. Explicitly wait for the GET /kpi
    // round-trip to be issued, then flush the `res.json()` + `setRange([])`
    // microtasks with an empty `act`, so the assertion below observes the
    // *settled* post-fetch render — where the bug and the fix actually
    // diverge (bug: range=[] is treated as authoritative → data=[] → 0
    // ticks; fix: falls through to the non-empty kpiBuffer → ticks render).
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/^\/kpi\?/)));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.querySelectorAll(".recharts-cartesian-axis-tick").length).toBeGreaterThan(0);
  });
});
