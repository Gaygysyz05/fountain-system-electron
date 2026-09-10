/** The smallest `count` integers >= `start`, as strings, not already in
 * `used` -- the shared "what's the next free ID" search behind every
 * suggested-value field in DeviceConfigPanel.tsx (a device's channel, a
 * nozzle's shared ID, a slave ID). `limit`, if given, caps the search so
 * a legitimately bounded range (a Node8's universe count, say) that's
 * already fully used doesn't loop forever; the search then simply
 * returns fewer than `count` results. */
export function nextFreeIds(used: Set<string>, start: number, count: number, limit?: number): string[] {
  const found: string[] = [];
  for (let n = start; found.length < count && (limit === undefined || n <= limit); n++) {
    const s = String(n);
    if (!used.has(s)) found.push(s);
  }
  return found;
}

export function nextFreeId(used: Set<string>, start: number, limit?: number): string {
  return nextFreeIds(used, start, 1, limit)[0] ?? String(start);
}
