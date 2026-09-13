/** Plain fallback for errors unrelated to the daemon connection (IPC calls, local asset loads) -- describeError's "can't reach the daemon" message would be misleading here. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Turns a raw fetch TypeError (network down, CORS blocked, daemon not running) into an actionable message; only for errors from talking to the daemon -- see errorMessage otherwise. */
export function describeError(err: unknown): string {
  if (err instanceof TypeError) {
    return "Can't reach the fountain daemon at 127.0.0.1:8765 -- check that it's running.";
  }
  return errorMessage(err);
}
