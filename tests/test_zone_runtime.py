"""Unit tests for ZoneRuntime + ZoneScenarioPlayer wiring -- the routing,
watchdog, and emergency-stop behavior that had zero coverage before this.
Uses a lightweight in-memory fake DriverInstance (no real network) since
these tests are about scheduling/routing logic, not any one driver's wire
protocol -- see test_modbus_valve.py etc. for that."""
from __future__ import annotations

import asyncio

from app.drivers.base import DeviceCategory
from app.event_bus import EventBus
from app.zone_runtime import ZoneRuntime
from app.zones.models import Event, Project


class FakeDriverInstance:
    def __init__(self, category: DeviceCategory, fail_channels: set[str] | None = None) -> None:
        self.category = category
        self._connected = True
        self.fail_channels = fail_channels or set()
        self.applied: list[tuple[str, dict]] = []
        self.emergency_stop_calls = 0

    async def connect(self) -> bool:
        self._connected = True
        return True

    async def disconnect(self) -> None:
        self._connected = False

    async def emergency_stop(self) -> None:
        self.emergency_stop_calls += 1

    def is_connected(self) -> bool:
        return self._connected

    async def register_channel(self, channel: str) -> bool:
        return channel not in self.fail_channels

    def apply_state(self, channel: str, state: dict) -> None:
        if channel in self.fail_channels:
            raise ValueError(f"bad channel {channel!r}")
        self.applied.append((channel, dict(state)))


def _register_fake_instance(zone: ZoneRuntime, instance_id: str, instance: FakeDriverInstance) -> None:
    """Direct-inserts a fake driver instance the way add_driver_instance
    would after create_instance() -- skips the registry/Pydantic config
    validation, which isn't what these tests are about."""
    zone.driver_instances[instance_id] = instance
    zone.instance_categories[instance_id] = instance.category
    zone.instance_driver_types[instance_id] = "fake"
    zone.instance_configs[instance_id] = {}


async def test_emergency_stop_stops_player_before_hardware() -> None:
    """The bug this guards: EMERGENCY_STOP used to only reach the driver
    instances, leaving the scenario tick loop running underneath -- a motor
    force-stopped by emergency_stop() could get re-armed by the very next
    scheduled event within one 50ms tick. emergency_stop() must stop the
    player FIRST."""
    bus = EventBus()
    zone = ZoneRuntime(zone_id=1, bus=bus)
    motor = FakeDriverInstance(DeviceCategory.MOTOR)
    _register_fake_instance(zone, "inv1", motor)
    await zone.add_device("M1", "inv1", "1")

    project = Project(duration=10.0, events=[
        Event(time=0.0, device_id="M1", parameters={"frequency": 30.0, "active": True}),
        Event(time=0.05, device_id="M1", parameters={"frequency": 40.0, "active": True}),
    ])
    zone.player.load_project(project, "s1")
    await zone.player.play()
    await asyncio.sleep(0.12)  # let the tick loop process the first event(s)

    assert "M1" in zone.player.active_devices  # motor opted into the watchdog

    await zone.emergency_stop()

    assert zone.player.is_playing is False
    assert "M1" not in zone.player.active_devices  # cleared by player.stop()
    assert motor.emergency_stop_calls == 1

    # Give the (now-cancelled) tick loop a chance to run if it somehow
    # wasn't actually stopped -- it must NOT apply anything further.
    applied_count_at_stop = len(motor.applied)
    await asyncio.sleep(0.15)
    assert len(motor.applied) == applied_count_at_stop


async def test_bad_device_does_not_kill_the_tick_loop_or_watchdog() -> None:
    """The bug this guards: one device raising out of apply_state (e.g. an
    unparseable channel) used to propagate out of the fire-and-forget tick
    task, killing it silently -- playback froze forever AND the watchdog
    (running from the same loop) stopped force-stopping already-active
    motors with it."""
    bus = EventBus()
    zone = ZoneRuntime(zone_id=1, bus=bus)
    good_motor = FakeDriverInstance(DeviceCategory.MOTOR)
    bad_motor = FakeDriverInstance(DeviceCategory.MOTOR, fail_channels={"bad"})
    _register_fake_instance(zone, "inv_good", good_motor)
    _register_fake_instance(zone, "inv_bad", bad_motor)
    await zone.add_device("GOOD", "inv_good", "1")
    await zone.add_device("BAD", "inv_bad", "bad")  # registered anyway, per add_device's contract

    project = Project(duration=10.0, events=[
        Event(time=0.0, device_id="BAD", parameters={"frequency": 10.0, "active": True}),
        Event(time=0.0, device_id="GOOD", parameters={"frequency": 10.0, "active": True}),
        Event(time=0.3, device_id="GOOD", parameters={"frequency": 20.0, "active": True}),
    ])
    zone.player.load_project(project, "s1")
    await zone.player.play()

    await asyncio.sleep(0.4)

    # The good device's SECOND event must still have been applied -- proof
    # the tick loop survived the bad device's exception at t=0 and kept ticking.
    assert any(p.get("frequency") == 20.0 for _, p in good_motor.applied)
    # The tick loop (and with it, is_playing) must still be alive.
    assert zone.player.is_playing is True

    await zone.player.stop()


async def test_watchdog_force_stops_unrefreshed_motor() -> None:
    """A motor whose event stream stalls (nothing refreshes active_devices)
    must be force-stopped by the watchdog, not left spinning forever."""
    bus = EventBus()
    zone = ZoneRuntime(zone_id=1, bus=bus)
    motor = FakeDriverInstance(DeviceCategory.MOTOR)
    _register_fake_instance(zone, "inv1", motor)
    await zone.add_device("M1", "inv1", "1")
    zone.player.watchdog_timeout = 0.1

    project = Project(duration=10.0, events=[
        Event(time=0.0, device_id="M1", parameters={"frequency": 30.0, "active": True}),
    ])
    zone.player.load_project(project, "s1")
    await zone.player.play()

    await asyncio.sleep(0.3)  # well past watchdog_timeout with no refresh

    assert "M1" not in zone.player.active_devices
    assert any(p.get("active") is False for _, p in motor.applied)

    await zone.player.stop()


async def test_set_device_state_registers_motor_in_watchdog() -> None:
    """A manual Devices-tab test-fire (SET_DEVICE_STATE) on a motor must
    opt into the same watchdog a scenario event would, so a forgotten test
    run doesn't spin a motor forever either."""
    bus = EventBus()
    zone = ZoneRuntime(zone_id=1, bus=bus)
    motor = FakeDriverInstance(DeviceCategory.MOTOR)
    _register_fake_instance(zone, "inv1", motor)
    await zone.add_device("M1", "inv1", "1")

    zone.set_device_state("M1", {"frequency": 15.0, "active": True})

    assert "M1" in zone.player.active_devices
    assert motor.applied == [("1", {"frequency": 15.0, "active": True})]

    zone.set_device_state("M1", {"frequency": 0.0, "active": False})
    assert "M1" not in zone.player.active_devices
