import type { ButtonHTMLAttributes } from "react";

/**
 * Hand-vendored primitive in shadcn style. shadcn/ui is deliberately NOT
 * installed via its CLI for this project — primitives (button, card,
 * badge, drawer, ...) are added by hand as later tasks need them. This
 * is the first one, establishing the src/components/ui/ convention.
 */
export function Button({
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center rounded-md bg-[var(--brand)] px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-50 ${className}`}
      {...props}
    />
  );
}
