import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useI18n } from "../src/i18n";
import { fleetStore, KPI_BUFFER_CAP } from "../src/store";
import { OrdersTab } from "../src/tabs/OrdersTab";
import { AnalyticsTab } from "../src/tabs/AnalyticsTab";
import type { StateFrame, TransportOrder } from "../src/types";

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
});
