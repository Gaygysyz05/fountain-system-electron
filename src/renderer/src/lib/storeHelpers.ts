/**
 * `await mutate(...args); await reload();` -- the shape of nearly every
 * mutating action in a fetch-on-mutate store (configStore, scheduleStore,
 * scenariosStore): send the command/REST call, then refetch to pick up
 * whatever changed, since none of these stores keep a live event stream
 * of their own (unlike zonesStore -- see its own top comment for why).
 * Was hand-written at every one of these call sites with nothing tying
 * them together; this is that shared shape, not a general-purpose utility.
 */
export function afterMutation<Args extends unknown[]>(
  mutate: (...args: Args) => Promise<unknown>,
  reload: () => Promise<void>,
): (...args: Args) => Promise<void> {
  return async (...args: Args) => {
    await mutate(...args);
    await reload();
  };
}
