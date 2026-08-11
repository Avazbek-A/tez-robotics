import type { ReactNode } from "react";

export interface BadgeProps {
  /** Hex color (e.g. "#4f46e5") — see src/status-colors.ts for the status → color maps. */
  color: string;
  children: ReactNode;
  className?: string;
}

/**
 * Hand-vendored primitive in shadcn style — see button.tsx for the convention note.
 * Status badges take an arbitrary hex color (rather than a fixed variant
 * enum) because the color family is shared across robot statuses AND order
 * statuses (see status-colors.ts), which don't map onto a single small set
 * of named variants.
 */
export function Badge({ color, children, className = "" }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${className}`}
      style={{ backgroundColor: `${color}26`, color }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
      {children}
    </span>
  );
}
