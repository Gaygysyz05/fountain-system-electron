/** Small underlined tab button -- shared by TimelinePanel.tsx's top-level
 * category tabs (Valves/Motors/Light/Scenes) and DeviceCategoryTabs.tsx's
 * per-driver-instance sub-tabs, so both levels look/behave identically. */
export function SubTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`border-b-2 px-xs py-1 text-sm ${
        active ? "border-accent text-text-primary" : "border-transparent text-text-muted hover:text-text-secondary"
      }`}
    >
      {label}
    </button>
  );
}
