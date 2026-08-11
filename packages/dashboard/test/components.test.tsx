import { beforeEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useI18n } from "../src/i18n";
import { RobotCard } from "../src/components/RobotCard";
import { TaskQueue } from "../src/components/TaskQueue";
import { KpiRow } from "../src/components/KpiRow";
import { AlarmDrawer } from "../src/components/AlarmDrawer";
import type { RobotState, TransportOrder } from "../src/types";

function makeRobot(overrides: Partial<RobotState> = {}): RobotState {
  return {
    id: "r1",
    pos: { x: 1, y: 1 },
    theta: 0,
    battery: 0.73,
    status: "EXECUTING",
    lastSeen: new Date().toISOString(),
    ...overrides,
  };
}

function makeOrder(overrides: Partial<TransportOrder> = {}): TransportOrder {
  return {
    id: "o1",
    pickupNode: "n1_1",
    dropNode: "n6_6",
    status: "queued",
    retries: 0,
    createdAt: new Date().toISOString(),
    history: [],
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  useI18n.setState({ lang: "en" });
});

describe("RobotCard", () => {
  it("renders battery % and status badge from a fixture RobotState", () => {
    const robot = makeRobot({ battery: 0.42, status: "CHARGING" });
    render(<RobotCard robot={robot} selected={false} onSelect={() => {}} />);

    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(screen.getByText("Charging")).toBeInTheDocument();
    expect(screen.getByText("r1")).toBeInTheDocument();
  });

  it("shows the current order id when one is assigned", () => {
    const robot = makeRobot();
    const order = makeOrder({ id: "o-42", status: "underway", robotId: "r1" as TransportOrder["robotId"] });
    render(<RobotCard robot={robot} currentOrder={order} selected={false} onSelect={() => {}} />);

    expect(screen.getByText("o-42")).toBeInTheDocument();
  });

  it("shows error text when status is ERROR", () => {
    const robot = makeRobot({ status: "ERROR" });
    render(<RobotCard robot={robot} selected={false} onSelect={() => {}} />);

    expect(screen.getByText("Robot reports an error")).toBeInTheDocument();
  });

  it("calls onSelect with the robot id when clicked", () => {
    const robot = makeRobot({ id: "r9" });
    let selected: string | undefined;
    render(<RobotCard robot={robot} selected={false} onSelect={(id) => (selected = id)} />);

    fireEvent.click(screen.getByTestId("robot-card-r9"));
    expect(selected).toBe("r9");
  });
});

describe("TaskQueue", () => {
  it("renders orders sorted queued-first", () => {
    const orders = [
      makeOrder({ id: "completed-1", status: "completed" }),
      makeOrder({ id: "underway-1", status: "underway" }),
      makeOrder({ id: "queued-1", status: "queued" }),
      makeOrder({ id: "dispatched-1", status: "dispatched" }),
      makeOrder({ id: "queued-2", status: "queued" }),
    ];
    render(<TaskQueue orders={orders} />);

    const rows = screen.getAllByTestId(/^order-row-/);
    const ids = rows.map((row) => row.getAttribute("data-testid"));
    expect(ids).toEqual([
      "order-row-queued-1",
      "order-row-queued-2",
      "order-row-dispatched-1",
      "order-row-underway-1",
      "order-row-completed-1",
    ]);
  });

  it("shows an empty state with no orders", () => {
    render(<TaskQueue orders={[]} />);
    expect(screen.getByText("No orders")).toBeInTheDocument();
  });
});

describe("KpiRow", () => {
  it("formats avgCycleMs to seconds with 1 decimal", () => {
    render(<KpiRow ordersPerHour={12} avgCycleMs={45678} utilization={0.5} queueDepth={3} />);
    expect(screen.getByText("45.7")).toBeInTheDocument();
  });

  it("renders orders/h, utilization %, and queue depth", () => {
    render(<KpiRow ordersPerHour={9.5} avgCycleMs={12000} utilization={0.876} queueDepth={4} />);
    expect(screen.getByText("9.5")).toBeInTheDocument();
    expect(screen.getByText("88%")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
  });
});

describe("AlarmDrawer", () => {
  it("opens on badge click and lists alarms newest-first", () => {
    render(<AlarmDrawer alarms={["first alarm", "second alarm", "third alarm"]} />);

    // Closed by default: the drawer's dialog isn't in the document.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /alarms/i }));

    const dialog = screen.getByRole("dialog");
    const items = within(dialog).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["third alarm", "second alarm", "first alarm"]);
  });

  it("shows the alarm count on the badge", () => {
    render(<AlarmDrawer alarms={["a", "b"]} />);
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("shows an empty state with no alarms", () => {
    render(<AlarmDrawer alarms={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /alarms/i }));
    expect(screen.getByText("No alarms")).toBeInTheDocument();
  });

  it("counts only real faults on the red badge; contention goes to the traffic section", () => {
    render(
      <AlarmDrawer
        alarms={[
          "robot r1 offline — order requeued",
          "t=5 contention: robot r2 could not claim 3:4 (owner=r1)",
          "t=6 contention: robot r3 could not claim 3:5 (owner=r2)",
        ]}
      />,
    );
    // badge: 1 fault + separate neutral counter for 2 traffic events
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /alarms/i }));
    expect(screen.getByText("Traffic coordination", { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/robot r1 offline/)).toBeInTheDocument();
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3); // 1 fault + 2 traffic, newest-first within each section
    expect(items[1].textContent).toContain("t=6");
    expect(items[2].textContent).toContain("t=5");
  });
});
