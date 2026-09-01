import { useConnectionStore } from "../../store/connectionStore";

/**
 * Play/Pause/Stop/Loop -- identical logic in the Controls tab's big hero
 * card and the Timeline tab's compact toolbar, just sized differently, so
 * it's written once here instead of twice with the button handlers drifting
 * apart.
 */
export function TransportButtons({
  zoneId,
  scenarioId,
  canPlay,
  loopEnabled,
  onToggleLoop,
  compact = false,
}: {
  zoneId: number;
  scenarioId: string;
  canPlay: boolean;
  loopEnabled: boolean;
  onToggleLoop: () => void;
  compact?: boolean;
}): JSX.Element {
  const sendCommand = useConnectionStore((s) => s.sendCommand);

  const secondaryClass = compact
    ? "h-7 rounded-control border border-border bg-bg-surface3 px-sm text-xs text-text-primary hover:bg-bg-surface2 disabled:cursor-not-allowed disabled:opacity-40"
    : "h-control rounded-control border border-border bg-bg-surface3 px-md text-sm text-text-primary hover:bg-bg-surface2 disabled:cursor-not-allowed disabled:opacity-40";
  const playClass = compact
    ? "h-7 rounded-control bg-success px-md text-xs font-semibold text-white hover:bg-success-hover disabled:cursor-not-allowed disabled:opacity-40"
    : "h-control flex flex-1 items-center justify-center gap-xs rounded-control bg-success px-lg text-sm font-semibold text-white hover:bg-success-hover disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div className="flex items-center gap-sm">
      <button
        disabled={!canPlay}
        onClick={() => void sendCommand({ command: "PLAY_SCENARIO", zone_id: zoneId, scenario_id: scenarioId })}
        className={playClass}
      >
        ▶ Play
      </button>
      <button onClick={() => void sendCommand({ command: "PAUSE_ZONE", zone_id: zoneId })} className={secondaryClass}>
        ⏸ Pause
      </button>
      <button onClick={() => void sendCommand({ command: "STOP_ZONE", zone_id: zoneId })} className={secondaryClass}>
        ⏹ Stop
      </button>
      <button
        onClick={onToggleLoop}
        className={`${secondaryClass} ${loopEnabled ? "border-accent text-accent" : ""}`}
        title="Toggle loop for this zone"
      >
        🔁 Loop {loopEnabled ? "On" : "Off"}
      </button>
    </div>
  );
}
