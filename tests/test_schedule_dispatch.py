"""Tests for main.py's scheduled-playback check -- _check_schedule reads
persistence.load_schedule() and, for anything due right now, plays that
zone's scenario the same way a PLAY_SCENARIO command would. Uses a fake
driver instance (see test_zone_runtime.py) rather than real hardware, and
monkeypatches the `datetime` name main.py imported for deterministic
"what time is it" control."""
from __future__ import annotations

import asyncio
from datetime import datetime

import pytest

from app import main as app_main
from app import persistence
from app.drivers.base import DeviceCategory


class _FixedDateTime:
    """Stands in for main.py's imported `datetime` class -- _check_schedule
    only ever calls datetime.now(), so only that needs stubbing."""

    def __init__(self, fixed: datetime) -> None:
        self._fixed = fixed

    def now(self) -> datetime:
        return self._fixed


class FakeDriverInstance:
    def __init__(self, category: DeviceCategory) -> None:
        self.category = category
        self.applied: list[tuple[str, dict]] = []

    async def connect(self) -> bool:
        return True

    async def disconnect(self) -> None:
        pass

    async def emergency_stop(self) -> None:
        pass

    def is_connected(self) -> bool:
        return True

    async def register_channel(self, channel: str) -> bool:
        return True

    def apply_state(self, channel: str, state: dict) -> None:
        self.applied.append((channel, dict(state)))


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    monkeypatch.setattr(persistence, "DATA_DIR", data_dir)
    monkeypatch.setattr(persistence, "SCENARIOS_DIR", data_dir / "scenarios")
    monkeypatch.setattr(persistence, "SCENARIO_BACKUPS_DIR", data_dir / "scenarios" / ".backups")
    monkeypatch.setattr(persistence, "SCHEDULE_FILE", data_dir / "schedule.json")
    monkeypatch.setattr(persistence, "AUDIT_LOG_FILE", data_dir / "audit.log")
    # app.main's `zones` dict is module-global state shared across the whole
    # test session -- clear it so one test's zone doesn't leak into another's.
    app_main.zones.clear()
    yield
    app_main.zones.clear()


async def _make_zone_with_motor():
    zone = app_main.get_zone(1)
    motor = FakeDriverInstance(DeviceCategory.MOTOR)
    zone.driver_instances["inv1"] = motor
    zone.instance_categories["inv1"] = motor.category
    zone.instance_driver_types["inv1"] = "fake"
    zone.instance_configs["inv1"] = {}
    await zone.add_device("M1", "inv1", "1")
    return zone, motor


async def _save_trivial_scenario(scenario_id: str, *, with_event: bool = False) -> None:
    events = (
        [persistence.ScenarioEventDto(time=0.0, device_id="M1", parameters={"frequency": 30.0, "active": True})]
        if with_event else []
    )
    await persistence.save_scenario(scenario_id, persistence.ScenarioFileDto(
        name=scenario_id, duration=5.0, events=events, music_file=None, device_ids=[],
    ))


async def test_due_entry_plays_its_scenario(monkeypatch) -> None:
    zone, motor = await _make_zone_with_motor()
    await _save_trivial_scenario("show1", with_event=True)
    await persistence.save_schedule([
        persistence.ScheduleEntryDto(id="e1", zone_id=1, scenario_id="show1", time="20:00", days=[], enabled=True),
    ])
    fixed_now = datetime(2026, 9, 1, 20, 0, 5)  # within the same HH:MM window
    monkeypatch.setattr(app_main, "datetime", _FixedDateTime(fixed_now))

    await app_main._check_schedule()
    await asyncio.sleep(0.1)  # let the tick loop process the t=0 event

    assert zone.player.is_playing is True
    assert any(p.get("active") is True for _, p in motor.applied)

    saved = persistence.load_schedule()
    assert saved[0].last_fired_date == "2026-09-01"

    await zone.player.stop()


async def test_entry_does_not_fire_twice_the_same_day(monkeypatch) -> None:
    await _make_zone_with_motor()
    await _save_trivial_scenario("show1")
    await persistence.save_schedule([
        persistence.ScheduleEntryDto(
            id="e1", zone_id=1, scenario_id="show1", time="20:00", days=[], enabled=True,
            last_fired_date="2026-09-01",  # already fired today
        ),
    ])
    monkeypatch.setattr(app_main, "datetime", _FixedDateTime(datetime(2026, 9, 1, 20, 0, 5)))

    await app_main._check_schedule()

    assert app_main.zones[1].player.is_playing is False


async def test_entry_skips_days_it_is_not_scheduled_for(monkeypatch) -> None:
    await _make_zone_with_motor()
    await _save_trivial_scenario("show1")
    fixed_now = datetime(2026, 9, 1, 20, 0, 5)
    wrong_day = (fixed_now.weekday() + 1) % 7  # guaranteed to not be today, whatever today is
    await persistence.save_schedule([
        persistence.ScheduleEntryDto(id="e1", zone_id=1, scenario_id="show1", time="20:00", days=[wrong_day], enabled=True),
    ])
    monkeypatch.setattr(app_main, "datetime", _FixedDateTime(fixed_now))

    await app_main._check_schedule()

    assert app_main.zones[1].player.is_playing is False


async def test_disabled_entry_does_not_fire(monkeypatch) -> None:
    await _make_zone_with_motor()
    await _save_trivial_scenario("show1")
    await persistence.save_schedule([
        persistence.ScheduleEntryDto(id="e1", zone_id=1, scenario_id="show1", time="20:00", days=[], enabled=False),
    ])
    monkeypatch.setattr(app_main, "datetime", _FixedDateTime(datetime(2026, 9, 1, 20, 0, 5)))

    await app_main._check_schedule()

    assert app_main.zones[1].player.is_playing is False


async def test_entry_for_a_missing_scenario_is_marked_fired_and_logged(monkeypatch) -> None:
    """A bad reference (deleted scenario, typo) must not spin -- retrying
    every 20s forever for a show that will never exist again is worse than
    just marking it fired and letting the operator notice and fix it."""
    await _make_zone_with_motor()
    await persistence.save_schedule([
        persistence.ScheduleEntryDto(id="e1", zone_id=1, scenario_id="does_not_exist", time="20:00", days=[], enabled=True),
    ])
    monkeypatch.setattr(app_main, "datetime", _FixedDateTime(datetime(2026, 9, 1, 20, 0, 5)))

    await app_main._check_schedule()

    saved = persistence.load_schedule()
    assert saved[0].last_fired_date == "2026-09-01"
    audit = persistence.read_audit_log()
    assert audit[0]["command"] == "SCHEDULED_PLAY"
    assert audit[0]["ok"] is False
