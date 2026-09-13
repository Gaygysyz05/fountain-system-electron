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

/** Splits a category into a sub-tab per driver instance only when devices span >1 instance, so identical channel numbers on different boards (e.g. two 32-ch relay boards) don't collide in one table. */
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

  const active = groups.find((g) => (g.instance?.instance_id ?? "__unassigned__") === selectedId) ?? groups[0] ?? null;
  // Memoized: DeviceTable resets grid selection/in-progress edits whenever `columns` changes identity, so an unmemoized array would wipe that state on unrelated ancestor re-renders.
  const columns = useMemo(() => (active ? buildColumns(category, active.devices) : []), [category, active]);

  if (groups.length === 0 || !active) {
    return (
      <p className="p-lg text-sm text-text-muted">
        No {category} devices selected for this scenario -- add some via "Edit devices…" above, or configure some on the Devices tab first.
      </p>
    );
  }

  if (groups.length === 1) {
    return <DeviceTablePanel category={category} columns={columns} instances={active.instance ? [active.instance] : []} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-md border-b border-border bg-bg-surface1 px-sm">
        {groups.map((g) => {
          const id = g.instance?.instance_id ?? "__unassigned__";
          return <SubTab key={id} label={g.instance?.instance_id ?? "Unassigned"} active={id === selectedId} onClick={() => setSelectedId(id)} />;
        })}
      </div>
      <DeviceTablePanel key={selectedId} category={category} columns={columns} instances={active.instance ? [active.instance] : []} />
    </div>
  );
}
