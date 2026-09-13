"""Bundles one zone's scheduler + driver instances, keyed by an arbitrary device map (not fixed valve/motor/light fields) so one fountain and forty fountains across six zones share the same code path."""
from __future__ import annotations

import logging

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
        # device_id -> last BASE (pre-global-scaling) parameters, so set_global_brightness/_speed can re-derive and re-send live devices against a new multiplier.
        self.device_last_parameters: dict[str, dict] = {}

        # Global live-control multipliers; applied here rather than in the category-agnostic ZoneScenarioPlayer, which doesn't know r/g/b means brightness or frequency means speed.
        self.global_brightness = 1.0
        self.global_speed = 1.0

        self.player.on_device_event = self._handle_device_event

    def rename(self, name: str | None) -> None:
        self.name = (name or "").strip() or None

    def set_global_brightness(self, value: int) -> None:
        """Re-dispatches every live light's last base parameters immediately, since level-triggered state otherwise wouldn't reflect a new multiplier until that device's next scenario cue."""
        self.global_brightness = max(0.0, min(1.0, value / 100.0))
        self._reapply_live_devices(DeviceCategory.LIGHT)

    def set_global_speed(self, value: int) -> None:
        """Same gap as set_global_brightness, for motors."""
        self.global_speed = max(0.0, min(1.0, value / 100.0))
        self._reapply_live_devices(DeviceCategory.MOTOR)

    def _reapply_live_devices(self, category: DeviceCategory) -> None:
        for device_id, parameters in list(self.device_last_parameters.items()):
            if self.device_categories.get(device_id) == category:
                self._dispatch_device_state(device_id, parameters)

    # -- driver instances (physical connections) ------------------------------

    async def add_driver_instance(self, instance_id: str, driver_type: str, config: dict, connect: bool = True) -> bool:
        if instance_id in self.driver_instances:
            return self.driver_instances[instance_id].is_connected()

        category = get_driver(driver_type).category
        instance, validated_config = create_instance(self.zone_id, instance_id, driver_type, config, self.bus)

        # Registered regardless of connect success: unreachable hardware at configure-time is a normal setup state, and the instance must still appear in GET /zones, persist to installation.json, and be retried by CONNECT_ZONE/restart.
        self.driver_instances[instance_id] = instance
        self.instance_categories[instance_id] = category
        self.instance_driver_types[instance_id] = driver_type
        self.instance_configs[instance_id] = config

        # Drivers that declare a fixed total_channels (e.g. modbus_relay_valve) get every channel auto-registered here instead of one at a time; reads validated_config (not raw config) so a schema-defaulted or string-coerced total_channels doesn't silently fail this isinstance check.
        total_channels = getattr(validated_config, "total_channels", None)
        if isinstance(total_channels, int) and total_channels > 0:
            for channel in range(1, total_channels + 1):
                await self.add_device(f"{instance_id}-{channel}", instance_id, str(channel))

        # connect=False registers the config (visible in GET /zones) without dialing out yet -- used by persistence.load_installation to register everything up front, then connect all instances concurrently in the background.
        if not connect:
            return False
        return await instance.connect()

    async def remove_driver_instance(self, instance_id: str) -> None:
        instance = self.driver_instances.pop(instance_id, None)
        self.instance_categories.pop(instance_id, None)
        self.instance_driver_types.pop(instance_id, None)
        self.instance_configs.pop(instance_id, None)
        if instance:
            # Stop before disconnecting: otherwise a motor/light left running here has no watchdog, reconnect, or way to be reached once the device map entries below are removed.
            try:
                await instance.emergency_stop()
            except Exception:  # noqa: BLE001
                logger.exception("zone %s: failed to stop instance %s before removing it", self.zone_id, instance_id)
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
        """(Re)connects every configured instance; filtering by category allows a partial retry (e.g. just the lights)."""
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

        # Registered regardless of register_channel's outcome, same as add_driver_instance: an unreachable channel must still be remembered, not dropped.
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
        self.device_last_parameters.pop(device_id, None)
        self.player.mark_device_inactive(device_id)

    # -- lifecycle --------------------------------------------------------------

    async def disconnect(self) -> None:
        await self.player.stop()
        await self.player.aclose()
        for instance_id, instance in list(self.driver_instances.items()):
            # Same reasoning as remove_driver_instance: stop hardware before tearing down the connection to it.
            try:
                await instance.emergency_stop()
            except Exception:  # noqa: BLE001
                logger.exception("zone %s: failed to stop instance %s before disconnecting", self.zone_id, instance_id)
            try:
                await instance.disconnect()
            except Exception:  # noqa: BLE001
                logger.exception("zone %s: error disconnecting a driver instance", self.zone_id)
        self.driver_instances.clear()
        self.instance_categories.clear()
        self.device_map.clear()
        self.device_categories.clear()
        self.device_nozzle_info.clear()
        self.device_last_parameters.clear()

    async def emergency_stop(self) -> None:
        """Must never raise (called from the command handler's error path too). Stops the player before any hardware so a still-ticking scenario can't re-arm a device within the same tick, and clears device_last_parameters so a post-stop slider move can't silently re-dispatch stale pre-stop values."""
        try:
            await self.player.stop()
        except Exception:  # noqa: BLE001
            logger.exception("zone %s: failed to stop scenario player during emergency stop", self.zone_id)

        self.device_last_parameters.clear()

        for instance_id, instance in list(self.driver_instances.items()):
            try:
                await instance.emergency_stop()
            except Exception:  # noqa: BLE001
                logger.exception("zone %s: emergency stop failed for instance %s", self.zone_id, instance_id)

    async def reset_motor_fault(self, device_id: str) -> bool:
        """Motor-only: unlike apply_state, a valve/light driver has no fault concept, so this raises rather than silently no-op'ing; uses getattr since fault reset isn't part of every driver's contract."""
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
        """Manual equivalent of _handle_device_event, sharing _dispatch_device_state's routing/watchdog/global-scaling so a manual test reflects an active SET_GLOBAL_SPEED/_BRIGHTNESS instead of sending the raw value."""
        if self._dispatch_device_state(device_id, parameters) is None:
            if device_id not in self.device_map:
                raise RuntimeError(f"unknown device '{device_id}'")
            raise RuntimeError(f"instance for '{device_id}' not found")

    # -- scheduler callback, injected into ZoneScenarioPlayer -------------------

    def _handle_device_event(self, event: Event) -> None:
        # skip_if_unchanged=True: scenarios repeat each device's last value every tick, so skip the driver write when nothing changed to avoid hammering the bus.
        if self._dispatch_device_state(event.device_id, event.parameters, skip_if_unchanged=True) is None:
            logger.warning("zone %s: event for unregistered device %s", self.zone_id, event.device_id)

    def _dispatch_device_state(self, device_id: str, parameters: dict, skip_if_unchanged: bool = False) -> tuple[str, str] | None:
        """Shared routing/watchdog/scaling for operator- and scenario-triggered writes. Only motors register with the watchdog, since valve/light state is level-triggered but a running VFD must be continuously re-affirmed or force-stopped. skip_if_unchanged only skips the driver write, never the watchdog refresh, so _reapply_live_devices can still re-send an unchanged value through a just-changed multiplier."""
        routing = self.device_map.get(device_id)
        if not routing:
            return None
        instance_id, channel = routing
        instance = self.driver_instances.get(instance_id)
        if not instance:
            return None

        category = self.device_categories.get(device_id)
        parameters = dict(parameters)
        # BASE (unscaled) value: what _reapply_live_devices re-derives from and what skip_if_unchanged diffs against.
        previous = self.device_last_parameters.get(device_id)
        self.device_last_parameters[device_id] = dict(parameters)

        if category == DeviceCategory.MOTOR:
            if parameters.get("active", False):
                self.player.mark_device_active(device_id)
            else:
                self.player.mark_device_inactive(device_id)

        if skip_if_unchanged and previous == parameters:
            return instance_id, channel

        if category == DeviceCategory.MOTOR:
            if self.global_speed != 1.0 and "frequency" in parameters:
                parameters["frequency"] = parameters["frequency"] * self.global_speed

        elif category == DeviceCategory.LIGHT and self.global_brightness != 1.0:
            for channel_key in ("r", "g", "b"):
                if channel_key in parameters:
                    parameters[channel_key] = parameters[channel_key] * self.global_brightness

        instance.apply_state(channel, parameters)
        return instance_id, channel
