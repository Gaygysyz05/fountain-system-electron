import { useEffect, useLayoutEffect, useRef } from "react";

export interface MenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}

export type MenuSection = MenuItem[];

/** Floating right-click menu replacing component_tables.py's per-table QMenu; closes on outside click, Escape, or after an item fires. */
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
  /** Default (192px) fits DeviceTable's long labels; short menus like AppShell's pass something tighter so they don't look like an empty box. */
  minWidthClassName?: string;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  // Clamps raw click coords to the viewport after measuring the rendered menu; runs in a layout effect (before paint) to avoid a visible jump.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 4;
    const maxLeft = window.innerWidth - rect.width - margin;
    const maxTop = window.innerHeight - rect.height - margin;
    el.style.left = `${Math.max(margin, Math.min(x, maxLeft))}px`;
    el.style.top = `${Math.max(margin, Math.min(y, maxTop))}px`;
  }, [x, y]);

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
