"""Unit tests for ZoneRuntime + ZoneScenarioPlayer wiring -- the routing,
watchdog, and emergency-stop behavior that had zero coverage before this.
Uses a lightweight in-memory fake DriverInstance (no real network) since
these tests are about scheduling/routing logic, not any one driver's wire
protocol -- see test_modbus_valve.py etc. for that."""
from __future__ import annotations

import asyncio

import app.drivers  # noqa: F401 -- registers modbus_relay_valve etc. (see app/drivers/__init__.py)
from app.drivers.base import DeviceCategory
from app.event_bus import EventBus
from app.zone_runtime import ZoneRuntime
from app.zones.models import Event, Project
from tests.fakes.fake_modbus import FakeModbusServer


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


async def test_set_device_state_applies_global_speed_scaling() -> None:
    """set_device_state used to be a second, independently-maintained copy
    of _handle_device_event's routing/watchdog logic that never applied
    global_speed -- an operator running a manual Devices-tab test while
    SET_GLOBAL_SPEED was active got the raw, unscaled frequency on the
    wire instead of the scaled value the rest of the zone was seeing."""
    bus = EventBus()
    zone = ZoneRuntime(zone_id=1, bus=bus)
    motor = FakeDriverInstance(DeviceCategory.MOTOR)
    _register_fake_instance(zone, "inv1", motor)
    await zone.add_device("M1", "inv1", "1")
    zone.set_global_speed(50)  # global_speed = 0.5

    zone.set_device_state("M1", {"frequency": 30.0, "active": True})

    assert motor.applied == [("1", {"frequency": 15.0, "active": True})]


async def test_set_device_state_applies_global_brightness_scaling() -> None:
    """Same gap as above, for lights: SET_GLOBAL_BRIGHTNESS must scale a
    manual Devices-tab test-fire the same way it scales a scenario event."""
    bus = EventBus()
    zone = ZoneRuntime(zone_id=1, bus=bus)
    light = FakeDriverInstance(DeviceCategory.LIGHT)
    _register_fake_instance(zone, "inv1", light)
    await zone.add_device("L1", "inv1", "1")
    zone.set_global_brightness(50)  # global_brightness = 0.5

    zone.set_device_state("L1", {"r": 200, "g": 100, "b": 0})

    assert light.applied == [("1", {"r": 100.0, "g": 50.0, "b": 0.0})]


async def test_set_global_speed_retroactively_rescales_an_already_running_motor() -> None:
    """SET_GLOBAL_SPEED used to only change the multiplier itself -- a
    motor's actual on-the-wire frequency is level-triggered (stays exactly
    as last set), so it kept running at its OLD, unscaled frequency until
    its next scenario event, which might be seconds away or might never
    come again for the rest of the show. Changing the slider must be
    reflected on the wire immediately, with no new event required."""
    bus = EventBus()
    zone = ZoneRuntime(zone_id=1, bus=bus)
    motor = FakeDriverInstance(DeviceCategory.MOTOR)
    _register_fake_instance(zone, "inv1", motor)
    await zone.add_device("M1", "inv1", "1")

    zone.set_device_state("M1", {"frequency": 30.0, "active": True})
    assert motor.applied[-1] == ("1", {"frequency": 30.0, "active": True})

    zone.set_global_speed(50)  # global_speed = 0.5, no new device event fired

    assert motor.applied[-1] == ("1", {"frequency": 15.0, "active": True})


async def test_set_global_brightness_retroactively_rescales_an_already_lit_light() -> None:
    """Same gap as set_global_speed above, for lights."""
    bus = EventBus()
    zone = ZoneRuntime(zone_id=1, bus=bus)
    light = FakeDriverInstance(DeviceCategory.LIGHT)
    _register_fake_instance(zone, "inv1", light)
    await zone.add_device("L1", "inv1", "1")

    zone.set_device_state("L1", {"r": 200, "g": 100, "b": 0})
    assert light.applied[-1] == ("1", {"r": 200, "g": 100, "b": 0})

    zone.set_global_brightness(50)  # global_brightness = 0.5, no new device event fired

    assert light.applied[-1] == ("1", {"r": 100.0, "g": 50.0, "b": 0.0})


async def test_repeated_identical_scenario_events_keep_the_motor_watchdog_refreshed() -> None:
    """A scenario export repeats each device's last value every ~1s for the
    whole show (see data/scenarios/salam.json) -- _dispatch_device_state
    used to silently swallow the whole event at the PLAYER level whenever
    it was identical to the last one, so a motor kept running via repeated
    identical events never got its watchdog refreshed past the very first
    one and was force-stopped a couple seconds later despite the scenario
    continuously commanding it to keep running."""
    bus = EventBus()
    zone = ZoneRuntime(zone_id=1, bus=bus)
    motor = FakeDriverInstance(DeviceCategory.MOTOR)
    _register_fake_instance(zone, "inv1", motor)
    await zone.add_device("M1", "inv1", "1")
    zone.player.watchdog_timeout = 0.15

    project = Project(duration=10.0, events=[
        Event(time=t, device_id="M1", parameters={"frequency": 30.0, "active": True})
        for t in (0.0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3)
    ])
    zone.player.load_project(project, "s1")
    await zone.player.play()

    await asyncio.sleep(0.4)  # past every event's time and past watchdog_timeout if refresh had stopped

    assert "M1" in zone.player.active_devices  # kept refreshed by the repeats, not timed out
    assert len(motor.applied) == 1  # but the repeats were identical -- only one actual driver write

    await zone.player.stop()


async def test_set_device_state_always_writes_even_when_unchanged() -> None:
    """Unlike a scenario tick's repeated identical event, a manual
    Devices-tab test-fire must always reach the driver -- an operator
    clicking the same test control twice expects it to actually re-send,
    not silently no-op because nothing "changed" from the daemon's point
    of view."""
    bus = EventBus()
    zone = ZoneRuntime(zone_id=1, bus=bus)
    motor = FakeDriverInstance(DeviceCategory.MOTOR)
    _register_fake_instance(zone, "inv1", motor)
    await zone.add_device("M1", "inv1", "1")

    zone.set_device_state("M1", {"frequency": 30.0, "active": True})
    zone.set_device_state("M1", {"frequency": 30.0, "active": True})  # identical repeat

    assert len(motor.applied) == 2


async def test_emergency_stop_clears_live_parameters_so_global_slider_does_not_rearm() -> None:
    """emergency_stop() used to only stop the player and the driver
    instances -- it never cleared device_last_parameters, the cache
    set_global_speed/_brightness's _reapply_live_devices() uses to
    re-dispatch a device's last parameters when the operator moves a
    slider. Left in place, touching a slider right after an E-stop --  an
    entirely plausible next move -- would silently re-send the motor's
    LAST pre-stop frequency straight back to the hardware, with no
    scenario running and thus no watchdog to catch it again."""
    bus = EventBus()
    zone = ZoneRuntime(zone_id=1, bus=bus)
    motor = FakeDriverInstance(DeviceCategory.MOTOR)
    _register_fake_instance(zone, "inv1", motor)
    await zone.add_device("M1", "inv1", "1")

    zone.set_device_state("M1", {"frequency": 30.0, "active": True})
    assert motor.applied[-1] == ("1", {"frequency": 30.0, "active": True})

    await zone.emergency_stop()
    applied_count_after_estop = len(motor.applied)

    zone.set_global_speed(50)  # must NOT re-arm the motor from its pre-stop parameters

    assert len(motor.applied) == applied_count_after_estop


def _track_stop_before_disconnect(instance: FakeDriverInstance) -> list[str]:
    calls: list[str] = []
    real_emergency_stop = instance.emergency_stop
    real_disconnect = instance.disconnect

    async def tracked_emergency_stop() -> None:
        calls.append("emergency_stop")
        await real_emergency_stop()

    async def tracked_disconnect() -> None:
        calls.append("disconnect")
        await real_disconnect()

    instance.emergency_stop = tracked_emergency_stop  # type: ignore[method-assign]
    instance.disconnect = tracked_disconnect  # type: ignore[method-assign]
    return calls


async def test_remove_driver_instance_stops_hardware_before_disconnecting() -> None:
    """remove_driver_instance used to disconnect() an instance (cancel
    tasks, close the socket) with no emergency_stop() first -- a motor
    spinning at its last commanded frequency, or a light lit at its last
    color, was left running with nothing in the daemon able to reach it
    once the instance and its devices were removed: no watchdog, no
    reconnect, no way to address it short of re-adding by hand."""
    bus = EventBus()
    zone = ZoneRuntime(zone_id=1, bus=bus)
    motor = FakeDriverInstance(DeviceCategory.MOTOR)
    calls = _track_stop_before_disconnect(motor)
    _register_fake_instance(zone, "inv1", motor)
    await zone.add_device("M1", "inv1", "1")

    await zone.remove_driver_instance("inv1")

    assert calls == ["emergency_stop", "disconnect"]


async def test_disconnect_stops_hardware_before_disconnecting_every_instance() -> None:
    """Same gap as remove_driver_instance above, for full zone teardown
    (DISCONNECT_ZONE / DELETE_ZONE): disconnect() used to tear down every
    instance's connection with no emergency_stop() first."""
    bus = EventBus()
    zone = ZoneRuntime(zone_id=1, bus=bus)
    motor = FakeDriverInstance(DeviceCategory.MOTOR)
    calls = _track_stop_before_disconnect(motor)
    _register_fake_instance(zone, "inv1", motor)
    await zone.add_device("M1", "inv1", "1")

    await zone.disconnect()

    assert calls == ["emergency_stop", "disconnect"]


async def test_disconnect_stops_the_scenario_players_watchdog_task() -> None:
    """disconnect() used to never call player.aclose() -- the standalone
    watchdog task (started lazily so a device marked active while nothing
    is playing still gets checked, see ZoneScenarioPlayer.mark_device_active)
    would then outlive the zone that started it, holding a reference to the
    player and polling a dict nothing can add to or clear through anymore."""
    bus = EventBus()
    zone = ZoneRuntime(zone_id=1, bus=bus)
    motor = FakeDriverInstance(DeviceCategory.MOTOR)
    _register_fake_instance(zone, "inv1", motor)
    await zone.add_device("M1", "inv1", "1")

    zone.player.mark_device_active("M1")  # starts the standalone watchdog task
    watchdog_task = zone.player._watchdog_task
    assert watchdog_task is not None and not watchdog_task.done()

    await zone.disconnect()

    assert watchdog_task.done()


async def test_add_driver_instance_uses_the_schema_default_total_channels() -> None:
    """total_channels defaults to 32 on ModbusValveConfig when the raw
    config omits it entirely -- a real operator flow (the config form only
    submits fields the user actually touched). add_driver_instance used to
    read total_channels off the RAW config dict, where an omitted field is
    simply absent (not defaulted), so the auto-registration loop never ran
    and the operator got zero devices instead of the 32 the schema promises."""
    bus = EventBus()
    zone = ZoneRuntime(zone_id=1, bus=bus)

    async with FakeModbusServer() as server:
        ok = await zone.add_driver_instance("rele1", "modbus_relay_valve", {
            "host": server.host,
            "port": server.port,
            # total_channels deliberately omitted -- must fall back to the
            # schema default (32), not silently register zero devices.
        })

        assert ok is True
        assert len(zone.device_map) == 32
        assert "rele1-1" in zone.device_map
        assert "rele1-32" in zone.device_map

        await zone.disconnect()
