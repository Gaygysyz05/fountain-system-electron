"""Tests for main.py's scheduled-playback check -- _check_schedule reads
persistence.load_schedule() and, for anything due right now, plays that
zone's scenario the same way a PLAY_SCENARIO command would. Uses a fake
driver instance (see test_zone_runtime.py) rather than real hardware, and
monkeypatches the `datetime` name main.py imported for deterministic
"what time is it" control."""
from __future__ import annotations

import asyncio
import json
from datetime import datetime

import pytest
from fastapi import HTTPException

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

    saved = await persistence.load_schedule()
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

    saved = await persistence.load_schedule()
    assert saved[0].last_fired_date == "2026-09-01"
    audit = await persistence.read_audit_log()
    assert audit[0]["command"] == "SCHEDULED_PLAY"
    assert audit[0]["ok"] is False


async def test_put_schedule_rejects_an_explicit_null_for_a_required_field() -> None:
    """entry.model_copy(update=...) used to skip validation entirely -- an explicit null for a
    required field ({"zone_id": null}, which a JS/TS client can send for "no change" just as easily
    as omitting the key) silently produced a type-invalid ScheduleEntryDto that got written straight
    to schedule.json, where it broke every subsequent read (_load_schedule_sync used to validate the
    whole list in one comprehension, with no per-entry isolation) until someone hand-edited the file."""
    await persistence.save_schedule([
        persistence.ScheduleEntryDto(id="e1", zone_id=1, scenario_id="show1", time="20:00", days=[], enabled=True),
    ])
    # zone_id=None here is EXPLICIT (passed as a kwarg), matching how Pydantic tracks a client's
    # literal {"zone_id": null} in a request body -- not the same as omitting the field entirely.
    payload = persistence.ScheduleEntryUpdateDto(zone_id=None)

    with pytest.raises(HTTPException) as exc_info:
        await app_main.update_schedule_entry("e1", payload)
    assert exc_info.value.status_code == 422

    # The rejected update must never have been written -- schedule.json stays exactly as it was.
    saved = await persistence.load_schedule()
    assert saved[0].zone_id == 1


async def test_schedule_transaction_serializes_concurrent_read_modify_write() -> None:
    """Two overlapping load-mutate-save cycles (e.g. _check_schedule mid-await racing an operator's
    PUT/DELETE) used to have nothing serializing them -- whichever finished its save LAST won
    outright, silently reverting the other's change. schedule_transaction() must make the second
    caller reload AFTER the first's save, not race it, so both edits survive."""
    await persistence.save_schedule([
        persistence.ScheduleEntryDto(id="e1", zone_id=1, scenario_id="show1", time="20:00", days=[], enabled=True),
        persistence.ScheduleEntryDto(id="e2", zone_id=1, scenario_id="show2", time="21:00", days=[], enabled=True),
    ])

    async def disable_e1() -> None:
        async with persistence.schedule_transaction() as (entries, save):
            await asyncio.sleep(0.05)  # widens the race window so both callers are definitely overlapping
            for e in entries:
                if e.id == "e1":
                    e.enabled = False
            await save(entries)

    async def delete_e2() -> None:
        async with persistence.schedule_transaction() as (entries, save):
            await asyncio.sleep(0.05)
            await save([e for e in entries if e.id != "e2"])

    await asyncio.gather(disable_e1(), delete_e2())

    final = await persistence.load_schedule()
    assert [e.id for e in final] == ["e1"]  # e2's deletion survived
    assert final[0].enabled is False  # ...and so did e1's edit -- neither reverted the other


async def test_load_schedule_skips_a_corrupt_entry_instead_of_failing_the_whole_list() -> None:
    """One invalid entry (a hand-edit, or a leftover from before the PUT-validation gap above was
    closed) used to blow up _load_schedule_sync's single list comprehension, taking down every OTHER
    zone's schedule too -- GET /schedule, every POST/PUT/DELETE, and the 20s _check_schedule poll all
    start with a load."""
    persistence.SCHEDULE_FILE.parent.mkdir(parents=True, exist_ok=True)
    persistence.SCHEDULE_FILE.write_text(json.dumps([
        {"id": "e1", "zone_id": 1, "scenario_id": "show1", "time": "20:00", "days": [], "enabled": True, "last_fired_date": None},
        {"id": "e2", "zone_id": None, "scenario_id": "show2", "time": "21:00", "days": [], "enabled": True, "last_fired_date": None},
    ]), encoding="utf-8")

    entries = await persistence.load_schedule()

    assert [e.id for e in entries] == ["e1"]
