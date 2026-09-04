import { useEffect, useRef } from "react";

export interface MenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}

export type MenuSection = MenuItem[];

/** Small floating right-click menu -- replaces component_tables.py's
 * QMenu-per-table (Copy/Paste/"Set Selected.../"Apply Pattern"/Add-Remove).
 * Closes on outside click, Escape, or after any item fires. */
export function ContextMenu({
  x,
  y,
  sections,
  onClose,
  minWidthClassName = "min-w-48",
}: {
  x: number;
  y: number;
  sections: MenuSection[];
  onClose: () => void;
  /** DeviceTable's right-click menus carry long labels ("Apply Pattern:
   * Alternate", "Set Selected: Open (1)") that need the 192px default to
   * read comfortably -- a short app-menu-style dropdown (see AppShell.tsx)
   * looks like a mostly-empty box at that width for a label like
   * "Settings", so it passes something tighter instead of inheriting a
   * width sized for a different menu's content. */
  minWidthClassName?: string;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDown(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{ left: x, top: y }}
      className={`fixed z-50 ${minWidthClassName} rounded-control border border-border bg-bg-surface2 py-1 shadow-lg`}
    >
      {sections.map((items, i) => (
        <div key={i} className={i > 0 ? "mt-1 border-t border-border pt-1" : undefined}>
          {items.map((item) => (
            <button
              key={item.label}
              disabled={item.disabled}
              onClick={() => {
                item.onClick();
                onClose();
              }}
              className={`block w-full px-md py-1 text-left text-sm hover:bg-bg-surface3 disabled:cursor-not-allowed disabled:opacity-40 ${
                item.danger ? "text-danger" : "text-text-primary"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
