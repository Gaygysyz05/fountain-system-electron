/** The standard text/number/select input look, used across every form in
 * this app -- was hand-copied verbatim at 13 call sites across 7 files
 * (some as a local `inputClass`/`fieldClass` const, some inlined
 * directly), so a deliberate style change (a different border radius, a
 * new focus ring) meant hunting down and editing all of them in lockstep. */
export const INPUT_CLASS =
  "h-input rounded-control border border-border bg-bg-surface3 px-sm text-sm text-text-primary focus:border-accent focus:outline-none";
