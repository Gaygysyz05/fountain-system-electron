"""Unit tests for persistence.py's scenario backup, audit log, and schedule
storage -- new this session, previously no coverage since the module didn't
have these responsibilities yet. Each test redirects the module's path
constants into pytest's tmp_path so nothing touches the real project's
data/ directory."""
from __future__ import annotations

import asyncio
import json
import time

import pytest

import app.drivers  # noqa: F401 -- registers modbus_relay_valve etc. (see app/drivers/__init__.py)
from app import persistence
from app.event_bus import EventBus
from app.persistence import ScenarioFileDto, ScheduleEntryDto
from app.zone_runtime import ZoneRuntime
from tests.fakes.fake_modbus import FakeModbusServer


@pytest.fixture(autouse=True)
def _isolated_data_dir(tmp_path, monkeypatch) -> None:
    data_dir = tmp_path / "data"
    monkeypatch.setattr(persistence, "DATA_DIR", data_dir)
    monkeypatch.setattr(persistence, "INSTALLATION_FILE", data_dir / "installation.json")
    monkeypatch.setattr(persistence, "SCENARIOS_DIR", data_dir / "scenarios")
    monkeypatch.setattr(persistence, "SCENARIO_BACKUPS_DIR", data_dir / "scenarios" / ".backups")
    monkeypatch.setattr(persistence, "AUDIT_LOG_FILE", data_dir / "audit.log")
    monkeypatch.setattr(persistence, "SCHEDULE_FILE", data_dir / "schedule.json")


def _scenario(name: str, duration: float = 10.0) -> ScenarioFileDto:
    return ScenarioFileDto(name=name, duration=duration, events=[], music_file=None, device_ids=[])


async def test_save_scenario_backs_up_previous_version_before_overwriting() -> None:
    await persistence.save_scenario("show1", _scenario("v1", duration=10.0))
    await persistence.save_scenario("show1", _scenario("v2", duration=20.0))

    backups_dir = persistence.SCENARIO_BACKUPS_DIR / "show1"
    backups = list(backups_dir.glob("*.json"))
    assert len(backups) == 1  # the v1 content, saved before v2 overwrote it
    backed_up = json.loads(backups[0].read_text(encoding="utf-8"))
    assert backed_up["name"] == "v1"

    current = await persistence.read_scenario_raw("show1")
    assert current["name"] == "v2"


async def test_first_save_creates_no_backup() -> None:
    """Nothing to back up yet -- a fresh scenario has no prior version."""
    await persistence.save_scenario("new_show", _scenario("first"))

    backups_dir = persistence.SCENARIO_BACKUPS_DIR / "new_show"
    assert not backups_dir.exists() or list(backups_dir.glob("*.json")) == []


async def test_scenario_backups_pruned_to_max() -> None:
    for i in range(persistence.MAX_BACKUPS_PER_SCENARIO + 5):
        await persistence.save_scenario("show1", _scenario(f"v{i}"))

    backups_dir = persistence.SCENARIO_BACKUPS_DIR / "show1"
    assert len(list(backups_dir.glob("*.json"))) <= persistence.MAX_BACKUPS_PER_SCENARIO


async def test_audit_log_read_back_most_recent_first() -> None:
    await persistence.append_audit_entry("PLAY_SCENARIO", 1, True, None)
    await persistence.append_audit_entry("EMERGENCY_STOP", None, True, None)
    await persistence.append_audit_entry("STOP_ZONE", 1, False, "zone not found")

    entries = await persistence.read_audit_log(limit=10)

    assert [e["command"] for e in entries] == ["STOP_ZONE", "EMERGENCY_STOP", "PLAY_SCENARIO"]
    assert entries[0]["ok"] is False
    assert entries[0]["error"] == "zone not found"


async def test_audit_log_rotates_when_oversized(monkeypatch) -> None:
    monkeypatch.setattr(persistence, "AUDIT_LOG_MAX_BYTES", 10)  # force rotation on the very next write

    await persistence.append_audit_entry("A", None, True, None)
    await persistence.append_audit_entry("B", None, True, None)  # file now over 10 bytes -> rotates before this write

    assert persistence.AUDIT_LOG_FILE.with_suffix(".log.1").exists()
    # The active file must still be valid JSONL (just the newest entry),
    # not left corrupt or unbounded by the rotation.
    entries = await persistence.read_audit_log(limit=10)
    assert entries[0]["command"] == "B"


async def test_schedule_round_trips_through_save_and_load() -> None:
    entry = ScheduleEntryDto(id="e1", zone_id=1, scenario_id="show1", time="20:00", days=[4, 5], enabled=True)
    await persistence.save_schedule([entry])

    loaded = await persistence.load_schedule()

    assert len(loaded) == 1
    assert loaded[0] == entry


def test_schedule_entry_rejects_malformed_time() -> None:
    with pytest.raises(ValueError):
        ScheduleEntryDto(id="e1", zone_id=1, scenario_id="show1", time="8:00")  # missing leading zero


async def test_read_scenario_raw_does_not_block_the_event_loop(monkeypatch) -> None:
    """The scenario read used to be a plain synchronous call, run inline on
    the same event loop that drives the daemon's 50ms hardware tick -- a
    slow disk (a USB installer drive, a contended one) would stall relay/VFD
    output for however long that read took. It must run in run_in_executor's
    worker thread instead, leaving the loop free to keep ticking (here, a
    concurrent counter task) while the "read" is in flight."""
    await persistence.save_scenario("show1", _scenario("v1"))

    real_sync_read = persistence._read_scenario_raw_sync

    def slow_read(scenario_id: str) -> dict:
        time.sleep(0.2)
        return real_sync_read(scenario_id)

    monkeypatch.setattr(persistence, "_read_scenario_raw_sync", slow_read)

    ticks = 0

    async def tick_counter() -> None:
        nonlocal ticks
        while True:
            ticks += 1
            await asyncio.sleep(0.01)

    counter_task = asyncio.create_task(tick_counter())
    try:
        result = await persistence.read_scenario_raw("show1")
    finally:
        counter_task.cancel()

    assert result["name"] == "v1"
    # The event loop kept advancing its own tick loop the whole time the
    # "disk read" was blocked in a worker thread -- a plain synchronous
    # read would have starved tick_counter() for the full 0.2s instead.
    assert ticks >= 5


async def test_load_installation_registers_without_connecting_to_hardware() -> None:
    """load_installation used to connect each configured instance inline,
    awaited one after another -- on an install with several boards and
    nothing reachable yet, that blocked the daemon's own ASGI startup
    (see main.py's lifespan) for however long every instance took to
    connect or time out, in sequence. It must now only register the
    configuration and hand back what still needs connecting, without
    itself dialing out at all."""
    async with FakeModbusServer() as server:
        payload = {
            "zones": [
                {
                    "zone_id": 1,
                    "name": "Zone 1",
                    "driver_instances": [
                        {
                            "instance_id": "rele1",
                            "driver_type": "modbus_relay_valve",
                            "config": {"host": server.host, "port": server.port},
                        }
                    ],
                    "devices": [],
                }
            ]
        }
        persistence.INSTALLATION_FILE.parent.mkdir(parents=True, exist_ok=True)
        persistence.INSTALLATION_FILE.write_text(json.dumps(payload), encoding="utf-8")

        bus = EventBus()
        zones: dict[int, ZoneRuntime] = {}

        def get_zone(zone_id: int) -> ZoneRuntime:
            if zone_id not in zones:
                zones[zone_id] = ZoneRuntime(zone_id, bus)
            return zones[zone_id]

        pending = await persistence.load_installation(get_zone)

        assert len(pending) == 1
        zone_id, instance_id, instance = pending[0]
        assert (zone_id, instance_id) == (1, "rele1")
        assert instance is zones[1].driver_instances["rele1"]
        # Registered (shows up in GET /zones) but genuinely not connected --
        # load_installation itself must never have called connect().
        assert instance.is_connected() is False

        await instance.connect()  # confirm it's a real, connectable instance
        assert instance.is_connected() is True
        await instance.disconnect()


async def test_device_model_node_round_trips_through_save_and_load() -> None:
    """SET_DEVICE_MODEL_NODE (the Preview tab's nozzle-mapping editor)
    assigns model_node long after the device itself was first configured
    -- it must survive a daemon restart the same way nozzle_group/
    nozzle_inverter already do, not just live in memory until the next
    restart quietly drops it."""
    async with FakeModbusServer() as server:
        bus = EventBus()
        zones: dict[int, ZoneRuntime] = {}

        def get_zone(zone_id: int) -> ZoneRuntime:
            if zone_id not in zones:
                zones[zone_id] = ZoneRuntime(zone_id, bus)
            return zones[zone_id]

        zone = get_zone(1)
        await zone.add_driver_instance(
            "rele1", "modbus_relay_valve",
            {"host": server.host, "port": server.port, "total_channels": 2},
            connect=False,
        )
        assert zone.set_device_model_node("rele1-1", "Farsunka.005") is True

        await persistence.save_installation(zones)

        reloaded: dict[int, ZoneRuntime] = {}

        def get_reloaded_zone(zone_id: int) -> ZoneRuntime:
            if zone_id not in reloaded:
                reloaded[zone_id] = ZoneRuntime(zone_id, bus)
            return reloaded[zone_id]

        await persistence.load_installation(get_reloaded_zone)

        assert reloaded[1].device_model_nodes.get("rele1-1") == "Farsunka.005"
        assert "rele1-2" not in reloaded[1].device_model_nodes  # unmapped device stays unmapped
