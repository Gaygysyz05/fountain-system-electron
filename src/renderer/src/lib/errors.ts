/**
 * A raw `fetch()` rejection (network down, CORS blocked, daemon not
 * running) surfaces as a generic `TypeError: Failed to fetch` -- accurate
 * for a developer, meaningless for an operator staring at a save button
 * that didn't work. This turns that into the one thing they actually need
 * to check first.
 */
export function describeError(err: unknown): string {
  if (err instanceof TypeError) {
    return "Can't reach the fountain daemon at 127.0.0.1:8765 -- check that it's running.";
  }
  return err instanceof Error ? err.message : String(err);
}
