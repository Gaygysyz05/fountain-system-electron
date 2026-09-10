/** Plain `catch (err) { ... }` -> readable-string fallback, no daemon-
 * specific assumptions -- for an error that has nothing to do with the
 * daemon connection (an IPC call to the main process, a local asset load),
 * where describeError's "can't reach the daemon" message below would be
 * actively misleading if it happened to be a TypeError for some unrelated
 * reason. Was duplicated inline at every one of these call sites before
 * this existed; describeError composes it, below, for the daemon case. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A raw `fetch()` rejection (network down, CORS blocked, daemon not
 * running) surfaces as a generic `TypeError: Failed to fetch` -- accurate
 * for a developer, meaningless for an operator staring at a save button
 * that didn't work. This turns that into the one thing they actually need
 * to check first. Only for errors that actually originate from talking to
 * the daemon (a WS command, a REST call) -- see errorMessage above for
 * anything else.
 */
export function describeError(err: unknown): string {
  if (err instanceof TypeError) {
    return "Can't reach the fountain daemon at 127.0.0.1:8765 -- check that it's running.";
  }
  return errorMessage(err);
}
