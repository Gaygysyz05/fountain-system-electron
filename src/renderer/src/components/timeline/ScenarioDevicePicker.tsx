import { useState } from "react";
import type { DeviceType, ZoneConfigDto } from "../../lib/protocol";
import { groupDevicesByInstance } from "./deviceColumns";

const CATEGORY_LABEL: Record<DeviceType, string> = { valve: "Valves", motor: "Motors", light: "Light" };
const CATEGORY_ORDER: DeviceType[] = ["valve", "motor", "light"];

/**
 * "Which devices does this scenario use?" -- shown when starting a new
 * scenario (default: everything checked, so clicking straight through
 * reproduces the old "show every zone device" behavior) and from "Edit
 * devices…" on an existing one. Confirming feeds TimelinePanel.tsx, which
 * narrows what Valves/Motors/Light show to just this selection -- so two
 * relay boards' worth of channels don't clutter a scenario that only
 * animates one fountain's lights, and the sub-tab split in
 * DeviceCategoryTabs.tsx only kicks in for instances actually in use here.
 */
export function ScenarioDevicePicker({
  zone,
  initialSelected,
  onConfirm,
  onCancel,
}: {
  zone: ZoneConfigDto;
  initialSelected: Set<string>;
  onConfirm: (ids: string[]) => void;
  onCancel: () => void;
}): JSX.Element {
  const [selected, setSelected] = useState<Set<string>>(new Set(initialSelected));

  function toggle(deviceId: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(deviceId)) next.delete(deviceId);
      else next.add(deviceId);
      return next;
    });
  }

  function setGroup(deviceIds: string[], on: boolean): void {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of deviceIds) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="flex max-h-[80vh] w-[32rem] flex-col gap-md overflow-hidden rounded-panel border border-border bg-bg-surface1 p-md shadow-lg">
        <div>
          <div className="text-sm font-medium text-text-primary">Which devices does this scenario use?</div>
          <div className="text-xs text-text-muted">Only selected devices show up in the Valves/Motors/Light tabs -- their scheduled events are kept either way.</div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {CATEGORY_ORDER.map((category) => {
            const categoryDevices = zone.devices.filter((d) => d.category === category);
            if (categoryDevices.length === 0) return null;
            const categoryInstances = zone.driver_instances.filter((i) => i.category === category);
            const groups = groupDevicesByInstance(categoryDevices, categoryInstances);
            const allIds = categoryDevices.map((d) => d.device_id);
            const allChecked = allIds.every((id) => selected.has(id));

            return (
              <div key={category} className="mb-md">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-medium uppercase tracking-wide text-text-muted">{CATEGORY_LABEL[category]}</span>
                  <button onClick={() => setGroup(allIds, !allChecked)} className="text-xs text-accent hover:text-accent-hover">
                    {allChecked ? "Deselect all" : "Select all"}
                  </button>
                </div>

                {groups.map((g, i) => {
                  // A driver that declares total_channels (the relay board)
                  // auto-provisions every channel of ONE physical device --
                  // this picker asks "does this scenario use this board",
                  // not "which of its 32 outputs", so it gets a single
                  // checkbox for the whole instance instead of one row (or
                  // even one channel chip) per channel. Anything added one
                  // at a time (a motor with its own slave ID, a nozzle
                  // pairing) keeps the per-device checkbox, since there
                  // each one genuinely is a separate thing to include.
                  const totalChannels = Number(g.instance?.config.total_channels ?? 0);
                  const isFixedBank = totalChannels > 0;
                  const groupIds = g.devices.map((d) => d.device_id);
                  const allSelected = groupIds.every((id) => selected.has(id));
                  const someSelected = groupIds.some((id) => selected.has(id));

                  return (
                    <div key={g.instance?.instance_id ?? `unassigned-${i}`} className="mb-xs">
                      {isFixedBank ? (
                        <label className="flex w-full items-center gap-sm rounded-control border border-border bg-bg-surface2 px-md py-sm text-sm hover:bg-bg-surface3">
                          <input
                            type="checkbox"
                            checked={allSelected}
                            ref={(el) => {
                              if (el) el.indeterminate = someSelected && !allSelected;
                            }}
                            onChange={() => setGroup(groupIds, !allSelected)}
                            className="h-4 w-4 accent-accent"
                          />
                          <span className="font-medium text-text-primary">{g.instance?.instance_id ?? "Unassigned"}</span>
                          <span className="text-text-muted">({groupIds.length} channels)</span>
                        </label>
                      ) : (
                        <>
                          {groups.length > 1 && <div className="mb-1 text-xs text-text-muted">{g.instance?.instance_id ?? "Unassigned"}</div>}
                          {/* Same row style as the fixed-bank checkbox above --
                              one full-width row per selectable thing either
                              way, so a category with a mix of boards and
                              individually-added devices doesn't read as two
                              different UIs mashed together. */}
                          <div className="flex flex-col gap-xs">
                            {g.devices.map((d) => (
                              <label
                                key={d.device_id}
                                className="flex w-full items-center gap-sm rounded-control border border-border bg-bg-surface2 px-md py-sm text-sm hover:bg-bg-surface3"
                              >
                                <input type="checkbox" checked={selected.has(d.device_id)} onChange={() => toggle(d.device_id)} className="h-4 w-4 accent-accent" />
                                <span className="font-medium text-text-primary">{d.device_id}</span>
                                <span className="text-text-muted">
                                  ({category === "motor" ? "slave " : "ch "}
                                  {d.channel}
                                  {d.nozzle_group != null ? `, Nozzle ${d.nozzle_group} Inv${d.nozzle_inverter}` : ""})
                                </span>
                              </label>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
          {zone.devices.length === 0 && <p className="text-sm text-text-muted">This zone has no devices configured yet.</p>}
        </div>

        <div className="flex justify-end gap-sm border-t border-border pt-sm">
          <button onClick={onCancel} className="h-control rounded-control border border-border bg-bg-surface3 px-md text-sm text-text-primary hover:bg-bg-surface2">
            Cancel
          </button>
          <button
            onClick={() => onConfirm([...selected])}
            className="h-control rounded-control bg-primary px-md text-sm text-text-primary hover:bg-primary-hover"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
