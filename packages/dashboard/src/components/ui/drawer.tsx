import type { ReactNode } from "react";

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}

/**
 * Hand-vendored primitive in shadcn style — see button.tsx for the convention note.
 * A right-side slide-over. Unmounts entirely when closed (rather than
 * staying mounted with a CSS transform) — simplest correct behavior for a
 * v1 alarm list, and it keeps testing-library queries honest ("not in the
 * document" instead of "present but visually hidden").
 */
export function Drawer({ open, onClose, title, children }: DrawerProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative flex h-full w-80 max-w-[90vw] flex-col overflow-y-auto border-l border-white/10 bg-[var(--surface-1)] p-4 shadow-xl"
      >
        {title && (
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="text-[var(--text)]/60 hover:text-[var(--text)]"
            >
              ✕
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
