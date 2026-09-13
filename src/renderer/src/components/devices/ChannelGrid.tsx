export interface ChannelGridItem {
  channel: string;
  active: boolean;
  title?: string;
}

/** Renders one physical board's channels as small numbered chips (not full-width rows), since they're one device's outputs, not separate devices; standalone devices with real identity (motor slave ID, nozzle pairing) get a full row instead -- see callers' total_channels check. */
const ACTIVE_CLASSES = {
  // Config-grid "included" color, matching the app's usual selected/on accent elsewhere in the UI.
  accent: "bg-accent text-white hover:bg-accent-hover",
  // Live-hardware test grid (ValveTestControl): deliberately a different color from the config grid's so "included in scenario" is never visually confused with "the relay is energized right now" -- warning-orange matches other live-test controls on this tab.
  warning: "bg-warning text-white hover:bg-warning-hover",
} as const;

export function ChannelGrid({
  items,
  onToggle,
  variant = "accent",
}: {
  items: ChannelGridItem[];
  onToggle: (channel: string) => void;
  variant?: keyof typeof ACTIVE_CLASSES;
}): JSX.Element {
  // Sorted numerically since callers pass devices in insertion order (not channel order); the grid must read 1, 2, 3... to look like the physical board.
  const sorted = [...items].sort((a, b) => Number(a.channel) - Number(b.channel));

  return (
    <div className="flex flex-wrap gap-xs">
      {sorted.map((item) => (
        <button
          key={item.channel}
          type="button"
          onClick={() => onToggle(item.channel)}
          title={item.title}
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-control text-xs font-medium ${
            item.active ? ACTIVE_CLASSES[variant] : "bg-bg-surface3 text-text-disabled hover:bg-bg-surface2"
          }`}
        >
          {item.channel}
        </button>
      ))}
    </div>
  );
}
