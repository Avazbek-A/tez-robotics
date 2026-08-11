import type { HTMLAttributes } from "react";

/** Hand-vendored primitive in shadcn style — see button.tsx for the convention note. */
export function Card({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-lg border border-white/10 bg-[var(--surface-1)] p-3 ${className}`}
      {...props}
    />
  );
}
