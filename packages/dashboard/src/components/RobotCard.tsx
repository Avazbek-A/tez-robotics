import type { RobotState, TransportOrder } from "../types";
import { useI18n } from "../i18n";
import { ROBOT_STATUS_COLORS } from "../status-colors";
import { Card } from "./ui/card";
import { Badge } from "./ui/badge";

const STATUS_LABEL_KEY: Record<RobotState["status"], string> = {
  IDLE: "statusIdle",
  EXECUTING: "statusExecuting",
  CHARGING: "statusCharging",
  ERROR: "statusError",
  UNKNOWN: "statusUnknown",
};

function batteryColor(pct: number): string {
  if (pct > 50) return "#22c55e";
  if (pct > 20) return "#f59e0b";
  return "#ef4444";
}

export interface RobotCardProps {
  robot: RobotState;
  /** The order this robot is currently carrying, if any (status dispatched/underway, robotId === robot.id). */
  currentOrder?: TransportOrder;
  selected: boolean;
  onSelect: (id: string) => void;
}

/**
 * Right-rail fleet card: battery bar, status badge, current order id, error
 * text. Click ⇄ map selection sync — this always *sets* the selection to
 * this robot's id (never toggles it off), matching PixiMap's
 * `onRobotClick` behavior (see map/PixiMap.tsx) so clicking a card and
 * clicking the same robot on the map behave identically.
 */
export function RobotCard({ robot, currentOrder, selected, onSelect }: RobotCardProps) {
  const t = useI18n((s) => s.t);
  const color = ROBOT_STATUS_COLORS[robot.status] ?? ROBOT_STATUS_COLORS.UNKNOWN;
  const batteryPct = Math.round(Math.max(0, Math.min(1, robot.battery)) * 100);

  return (
    <Card
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      data-testid={`robot-card-${robot.id}`}
      onClick={() => onSelect(robot.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(robot.id);
        }
      }}
      className={`cursor-pointer select-none transition-colors ${
        selected ? "border-[var(--brand)]" : "hover:border-white/20"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono-num text-sm font-semibold">{robot.id}</span>
        <Badge color={color}>{t(STATUS_LABEL_KEY[robot.status] ?? "statusUnknown")}</Badge>
      </div>

      <div
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10"
        role="progressbar"
        aria-label={t("battery")}
        aria-valuenow={batteryPct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full transition-[width]"
          style={{ width: `${batteryPct}%`, backgroundColor: batteryColor(batteryPct) }}
        />
      </div>
      <div className="mt-1 flex items-center justify-between text-xs text-[var(--text)]/60">
        <span>{t("battery")}</span>
        <span className="font-mono-num">{batteryPct}%</span>
      </div>

      {currentOrder && (
        <div className="mt-2 truncate text-xs text-[var(--text)]/60">
          {t("orderId")}: <span className="font-mono-num text-[var(--text)]">{currentOrder.id}</span>
        </div>
      )}

      {robot.status === "ERROR" && (
        <div className="mt-2 text-xs text-[#ef4444]">{t("robotErrorText")}</div>
      )}
    </Card>
  );
}
