"""
Bundles one zone's scheduler + driver instances and routes scenario events
between them. Rewritten around the driver registry (app/drivers/base.py):
ZoneRuntime no longer knows about valves/motors/lights as distinct fields --
it holds an arbitrary set of driver instances (physical connections) and a
device map (scenario-facing device_id -> which instance + channel), built up
entirely from ADD_DRIVER_INSTANCE / ADD_DEVICE commands rather than a fixed
zone_config shape. This is what makes "one fountain" and "forty fountains
across six zones" the same code path.
"""
from __future__ import annotations

import logging
import time

from app.drivers.base import DeviceCategory, DriverInstance, create_instance, get_driver
from app.event_bus import EventBus
from app.zones.models import Event
from app.zones.scenario_player import ZoneScenarioPlayer

logger = logging.getLogger("fountain.zone_runtime")


class ZoneRuntime:
    def __init__(self, zone_id: int, bus: EventBus) -> None:
        self.zone_id = zone_id
        self.bus = bus
        self.name: str | None = None  # display label only -- see RenameZone in protocol.py
        self.player = ZoneScenarioPlayer(zone_id, bus)

        self.driver_instances: dict[str, DriverInstance] = {}
        self.instance_categories: dict[str, DeviceCategory] = {}
        self.instance_driver_types: dict[str, str] = {}
        self.instance_configs: dict[str, dict] = {}
        self.device_map: dict[str, tuple[str, str]] = {}  # device_id -> (instance_id, channel)
        self.device_categories: dict[str, DeviceCategory] = {}
        self.device_nozzle_info: dict[str, tuple[str, int]] = {}  # device_id -> (nozzle_group, inverter 1|2), motor devices only

        # Global live-control multipliers (SET_GLOBAL_BRIGHTNESS/_SPEED).
        # Applied here, not in ZoneScenarioPlayer, because the scheduler is
        # deliberately category-agnostic (see its docstring) -- it has no
        # idea a "light" event's r/g/b means brightness or a "motor" event's
        # frequency means speed. ZoneRuntime already looks up the category
        # for every event anyway (the watchdog opt-in below), so applying
        # the multiplier here costs nothing extra and keeps the scheduler clean.
        self.global_brightness = 1.0
        self.global_speed = 1.0

        self.player.on_device_event = self._handle_device_event

    def rename(self, name: str | None) -> None:
        self.name = (name or "").strip() or None

    def set_global_brightness(self, value: int) -> None:
        self.global_brightness = max(0.0, min(1.0, value / 100.0))

    def set_global_speed(self, value: int) -> None:
        self.global_speed = max(0.0, min(1.0, value / 100.0))

    # -- driver instances (physical connections) ------------------------------

    async def add_driver_instance(self, instance_id: str, driver_type: str, config: dict) -> bool:
        if instance_id in self.driver_instances:
            return self.driver_instances[instance_id].is_connected()

        category = get_driver(driver_type).category
        instance, validated_config = create_instance(self.zone_id, instance_id, driver_type, config, self.bus)

        # Registered regardless of whether this first connect attempt
        # succeeds: hardware being unreachable at configure-time (not yet
        # powered on, cabling not run yet) is a normal setup state, not a
        # reason to forget the instance was ever configured. It must still
        # show up in GET /zones, survive into installation.json, and be
        # retried by CONNECT_ZONE / on daemon restart -- see app/persistence.py.
        self.driver_instances[instance_id] = instance
        self.instance_categories[instance_id] = category
        self.instance_driver_types[instance_id] = driver_type
        self.instance_configs[instance_id] = config

        # A driver whose config declares a fixed channel count (a 32-channel
        # relay board's total_channels, say) has every one of those channels
        # physically present the moment the board itself is configured --
        # there's no real "add channel 7" step for hardware where channel 7
        # already exists on the PCB. Auto-registering them here means the
        # operator sets total_channels ONCE, instead of clicking "Add
        # device" once per channel (32 times for a full relay bank). Device
        # IDs are namespaced by instance_id so two boards each with their
        # own channels 1..32 don't collide. Only fires for driver configs
        # that actually declare total_channels (currently just
        # modbus_relay_valve) -- motors and Art-Net lights have no such
        # fixed-bank concept and still get added one at a time.
        #
        # Read from validated_config, not the raw config dict: total_channels
        # has a schema default (32) that an operator who omits the field
        # entirely never sees reflected in raw_config, and a value submitted
        # as e.g. the string "32" only becomes a real int after validation --
        # either case used to make this isinstance(..., int) check silently
        # false and skip auto-registration altogether.
        total_channels = getattr(validated_config, "total_channels", None)
        if isinstance(total_channels, int) and total_channels > 0:
            for channel in range(1, total_channels + 1):
                await self.add_device(f"{instance_id}-{channel}", instance_id, str(channel))

        return await instance.connect()

    async def remove_driver_instance(self, instance_id: str) -> None:
        instance = self.driver_instances.pop(instance_id, None)
        self.instance_categories.pop(instance_id, None)
        self.instance_driver_types.pop(instance_id, None)
        self.instance_configs.pop(instance_id, None)
        if instance:
            await instance.disconnect()

        stale_devices = [d for d, (iid, _) in self.device_map.items() if iid == instance_id]
        for device_id in stale_devices:
            self.remove_device(device_id)

    async def reconnect_instance(self, instance_id: str) -> None:
        instance = self.driver_instances.get(instance_id)
        if not instance:
            raise RuntimeError(f"unknown instance '{instance_id}'")
        await instance.connect()

    async def connect_all(self, categories: set[DeviceCategory] | None = None) -> dict[str, bool]:
        """(Re)connects every configured instance -- what CONNECT_ZONE now
        means, since instances already connect at add-time. Filtering by
        category lets a partial "just reconnect the lights" retry happen
        without touching everything else."""
        results: dict[str, bool] = {}
        for instance_id, instance in self.driver_instances.items():
            if categories and self.instance_categories.get(instance_id) not in categories:
                continue
            results[instance_id] = instance.is_connected() or await instance.connect()
        return results

    # -- devices (scenario-facing channels within an instance) ----------------

    async def add_device(
        self, device_id: str, instance_id: str, channel: str,
        nozzle_group: str | None = None, nozzle_inverter: int | None = None,
    ) -> bool:
        if instance_id not in self.driver_instances:
            logger.warning("zone %s: cannot add device %s, unknown instance %s", self.zone_id, device_id, instance_id)
            return False

        # Registered regardless of register_channel's outcome -- same
        # reasoning as add_driver_instance: a motor not yet reachable on a
        # shared RTU/TCP bus (or any other not-yet-responsive channel) must
        # still be remembered, not silently dropped from the configuration.
        if not await self.driver_instances[instance_id].register_channel(channel):
            logger.warning("zone %s: device %s (channel %s on %s) did not come up, registering anyway",
                           self.zone_id, device_id, channel, instance_id)

        self.device_map[device_id] = (instance_id, channel)
        self.device_categories[device_id] = self.instance_categories[instance_id]
        if nozzle_group is not None and nozzle_inverter is not None:
            self.device_nozzle_info[device_id] = (nozzle_group, nozzle_inverter)
        else:
            self.device_nozzle_info.pop(device_id, None)
        return True

    def remove_device(self, device_id: str) -> None:
        self.device_map.pop(device_id, None)
        self.device_categories.pop(device_id, None)
        self.device_nozzle_info.pop(device_id, None)
        self.player.active_devices.pop(device_id, None)

    # -- lifecycle --------------------------------------------------------------

    async def disconnect(self) -> None:
        await self.player.stop()
        for instance in list(self.driver_instances.values()):
            try:
                await instance.disconnect()
            except Exception:  # noqa: BLE001
                logger.exception("zone %s: error disconnecting a driver instance", self.zone_id)
        self.driver_instances.clear()
        self.instance_categories.clear()
        self.device_map.clear()
        self.device_categories.clear()
        self.device_nozzle_info.clear()

    async def emergency_stop(self) -> None:
        """Must never raise: called from the command handler's error path too.

        Stops the scenario player FIRST, before touching any hardware: it
        used to only reach the driver instances, leaving the tick loop
        running underneath. A motor mid-ramp or a valve about to reopen
        would get force-stopped by this call and then, within one 50ms tick,
        get re-armed by the next scheduled event the still-running player
        dispatched right after -- an emergency stop that only lasted until
        the next tick isn't one. Stopping the player also clears
        active_devices (the watchdog set), which is correct here: nothing
        should still be "must be refreshed or force-stopped" once every
        instance has already been told to stop."""
        try:
            await self.player.stop()
        except Exception:  # noqa: BLE001
            logger.exception("zone %s: failed to stop scenario player during emergency stop", self.zone_id)

        for instance_id, instance in list(self.driver_instances.items()):
            try:
                await instance.emergency_stop()
            except Exception:  # noqa: BLE001
                logger.exception("zone %s: emergency stop failed for instance %s", self.zone_id, instance_id)

    async def reset_motor_fault(self, device_id: str) -> bool:
        """Clears a tripped VFD fault so the drive accepts run commands
        again. Deliberately scoped to motor-category devices only -- unlike
        apply_state (category-agnostic, the driver just interprets whatever
        shape it gets), a valve/light driver has no fault concept to clear,
        so this raises for anything else instead of silently no-op'ing on a
        device that doesn't support it, matching add_device's "unknown
        instance" -> raise -> Ack(ok=False) precedent in main.py.
        `getattr(..., None)` rather than a required DriverInstance protocol
        method: fault reset is meaningful to exactly one driver category
        today (motor), so it isn't part of the universal contract every
        valve/light driver would otherwise have to stub out."""
        routing = self.device_map.get(device_id)
        if not routing:
            raise RuntimeError(f"unknown device '{device_id}'")
        if self.device_categories.get(device_id) != DeviceCategory.MOTOR:
            raise RuntimeError(f"'{device_id}' is not a motor -- fault reset only applies to motors")

        instance_id, channel = routing
        instance = self.driver_instances.get(instance_id)
        reset_fault = getattr(instance, "reset_fault", None)
        if reset_fault is None:
            raise RuntimeError(f"driver for '{device_id}' does not support fault reset")
        return await reset_fault(channel)

    def set_device_state(self, device_id: str, parameters: dict) -> None:
        """Manual equivalent of _handle_device_event below -- same routing,
        same motor-watchdog registration (so a test "run at 10Hz" still
        gets force-stopped if nothing keeps refreshing it, exactly like a
        scenario event would), just triggered by an operator clicking a
        Devices-tab test control instead of the scenario player reaching
        this device's next scheduled tick. Valve/light state is level-
        triggered and simply stays as set. Routing/watchdog/global-scaling
        logic itself lives in _dispatch_device_state, shared with
        _handle_device_event -- this used to be a second copy of that
        logic that had quietly fallen out of sync (it never applied
        global_speed/global_brightness), so an operator running a manual
        test while SET_GLOBAL_SPEED was active got the raw, unscaled value
        on the wire instead of what the rest of the zone was seeing."""
        if self._dispatch_device_state(device_id, parameters) is None:
            if device_id not in self.device_map:
                raise RuntimeError(f"unknown device '{device_id}'")
            raise RuntimeError(f"instance for '{device_id}' not found")

    # -- scheduler callback, injected into ZoneScenarioPlayer -------------------

    def _handle_device_event(self, event: Event) -> None:
        if self._dispatch_device_state(event.device_id, event.parameters) is None:
            logger.warning("zone %s: event for unregistered device %s", self.zone_id, event.device_id)

    def _dispatch_device_state(self, device_id: str, parameters: dict) -> tuple[str, str] | None:
        """Shared by set_device_state (operator-triggered) and
        _handle_device_event (scenario-triggered): routing lookup,
        motor-watchdog registration, and global_speed/global_brightness
        scaling. Only motors opt into the watchdog: valve/light states are
        level-triggered (stay in whatever state they were last set to), a
        running VFD is not -- it must be continuously re-affirmed or
        ZoneScenarioPlayer's watchdog force-stops it (Step 3 safety net).
        Returns the (instance_id, channel) routing on success, or None if
        the device or its instance isn't found -- callers decide how to
        report that (raise vs. log-and-return)."""
        routing = self.device_map.get(device_id)
        if not routing:
            return None
        instance_id, channel = routing
        instance = self.driver_instances.get(instance_id)
        if not instance:
            return None

        category = self.device_categories.get(device_id)
        parameters = dict(parameters)

        if category == DeviceCategory.MOTOR:
            if parameters.get("active", False):
                self.player.active_devices[device_id] = time.monotonic()
            else:
                self.player.active_devices.pop(device_id, None)

            if self.global_speed != 1.0 and "frequency" in parameters:
                parameters["frequency"] = parameters["frequency"] * self.global_speed

        elif category == DeviceCategory.LIGHT and self.global_brightness != 1.0:
            for channel_key in ("r", "g", "b"):
                if channel_key in parameters:
                    parameters[channel_key] = parameters[channel_key] * self.global_brightness

        instance.apply_state(channel, parameters)
        return instance_id, channel
