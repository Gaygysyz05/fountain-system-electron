import { useEffect, useMemo, useState } from "react";
import type { DeviceDto, DeviceType, DriverInstanceDto } from "../../lib/protocol";
import { buildLightColumns, buildMotorColumns, buildValveColumns, groupDevicesByInstance, type DeviceColumn } from "./deviceColumns";
import { DeviceTablePanel } from "./DeviceTablePanel";
import { SubTab } from "./SubTab";

function buildColumns(category: DeviceType, devices: DeviceDto[]): DeviceColumn[] {
  switch (category) {
    case "valve":
      return buildValveColumns(devices);
    case "motor":
      return buildMotorColumns(devices);
    case "light":
      return buildLightColumns(devices);
  }
}

/**
 * Splits one category (Valves/Motors/Light) into a sub-tab per driver
 * instance (physical board) when the scenario's selected devices span more
 * than one instance -- e.g. two 32-channel relay boards both categorized
 * "valve". Without this, both boards' channel 1 would sit side by side in
 * one table with nothing to tell them apart. When there's only one
 * instance (the common case), this renders straight through to
 * DeviceTablePanel with no extra tab level.
 */
export function DeviceCategoryTabs({
  category,
  devices,
  instances,
}: {
  category: DeviceType;
  devices: DeviceDto[];
  instances: DriverInstanceDto[];
}): JSX.Element {
  const groups = useMemo(() => groupDevicesByInstance(devices, instances), [devices, instances]);
  const groupIds = useMemo(() => groups.map((g) => g.instance?.instance_id ?? "__unassigned__"), [groups]);

  const [selectedId, setSelectedId] = useState<string>(() => groupIds[0] ?? "");
  useEffect(() => {
    if (!groupIds.includes(selectedId)) setSelectedId(groupIds[0] ?? "");
  }, [groupIds, selectedId]);

  if (groups.length === 0) {
    return (
      <p className="p-lg text-sm text-text-muted">
        No {category} devices selected for this scenario -- add some via "Edit devices…" above, or configure some on the Devices tab first.
      </p>
    );
  }

  if (groups.length === 1) {
    const only = groups[0];
    return <DeviceTablePanel category={category} columns={buildColumns(category, only.devices)} instances={only.instance ? [only.instance] : []} />;
  }

  const active = groups.find((g) => (g.instance?.instance_id ?? "__unassigned__") === selectedId) ?? groups[0];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-md border-b border-border bg-bg-surface1 px-sm">
        {groups.map((g) => {
          const id = g.instance?.instance_id ?? "__unassigned__";
          return <SubTab key={id} label={g.instance?.instance_id ?? "Unassigned"} active={id === selectedId} onClick={() => setSelectedId(id)} />;
        })}
      </div>
      <DeviceTablePanel key={selectedId} category={category} columns={buildColumns(category, active.devices)} instances={active.instance ? [active.instance] : []} />
    </div>
  );
}
