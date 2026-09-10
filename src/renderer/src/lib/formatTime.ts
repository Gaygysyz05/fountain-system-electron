/** Formats a playback/duration position in seconds as `M:SS` (minutes NOT
 * zero-padded, e.g. "1:05" not "01:05") -- the shared implementation for
 * every screen that shows a scenario position or duration. Previously
 * duplicated across ScenarioTimelinePlayer.tsx, PianoRollEditor.tsx, and
 * LiveTimecode.tsx, and had drifted: LiveTimecode's copy zero-padded
 * minutes too, so the same position could read "01:05" on one screen and
 * "1:05" on another. */
export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
