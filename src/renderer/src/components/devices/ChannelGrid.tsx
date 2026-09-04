export interface ChannelGridItem {
  channel: string;
  active: boolean;
  title?: string;
}

/**
 * A compact numbered grid for the channels of ONE physical fixed-bank
 * device (a 32-channel relay board, say) -- e.g. Devices tab and
 * ScenarioDevicePicker.tsx both used to list every channel as its own
 * full-width row ("Rele 1-17 — channel 17 [Remove]"), which read as "17
 * separate devices" when it's one board with 17th of 32 outputs. A channel
 * is just a number on that one board, so it's rendered as one: a small
 * numbered chip, not a labeled row with its own Remove button.
 *
 * Deliberately NOT used for a manually-added-one-at-a-time device (a motor
 * with its own slave ID, a nozzle pairing) -- there each device genuinely
 * has its own identity worth a full row (see the callers for the total_channels
 * check that decides which presentation applies).
 */
const ACTIVE_CLASSES = {
  // Config grid (include/exclude a channel from scenarios) -- the app's
  // usual accent color, matching every other "this is selected/on" chip
  // elsewhere in the UI.
  accent: "bg-accent text-white hover:bg-accent-hover",
  // Live-hardware test grid (see DeviceConfigPanel.tsx's ValveTestControl)
  // -- deliberately a DIFFERENT color from the config grid's, not just a
  // different label: the two grids sit right next to each other and both
  // read as "a grid of channel chips", so if "active" ever looked the same
  // in both, a glance couldn't tell "included in the scenario" apart from
  // "the real relay is energized right now". Warning-orange reads as "this
  // is live" the same way it does on Motor's "Test 10Hz" / Light's own test
  // controls elsewhere on this tab.
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
  // Numeric order regardless of input order -- callers pass devices in
  // whatever order the daemon's device map iterates them, which is
  // insertion order, not channel order (re-adding a previously-removed
  // channel puts it last). A channel grid that doesn't read 1, 2, 3... left
  // to right defeats the point of it looking like the physical board.
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
