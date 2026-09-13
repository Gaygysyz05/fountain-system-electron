"""Installation config (hardware wiring) and scenarios (show timelines) are persisted separately so changing one never forces a rewrite of the other."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

from pydantic import BaseModel, Field

from app.drivers.base import DriverInstance
from app.zone_runtime import ZoneRuntime
from app.zones.models import Event, Project

logger = logging.getLogger("fountain.persistence")

DATA_DIR = Path("data")
INSTALLATION_FILE = DATA_DIR / "installation.json"
SCENARIOS_DIR = DATA_DIR / "scenarios"
SCENARIO_BACKUPS_DIR = SCENARIOS_DIR / ".backups"
MAX_BACKUPS_PER_SCENARIO = 20
AUDIT_LOG_FILE = DATA_DIR / "audit.log"
AUDIT_LOG_MAX_BYTES = 5 * 1024 * 1024
SCHEDULE_FILE = DATA_DIR / "schedule.json"

_SAFE_SCENARIO_ID = re.compile(r"^[A-Za-z0-9_-]+$")
_TIME_OF_DAY = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def _write_text_atomic(path: Path, content: str, encoding: str = "utf-8") -> None:
    """Writes via temp file + atomic rename, since write_text() truncates first -- a crash mid-write would otherwise leave installation.json corrupt and load_installation() would silently start with no configured hardware."""
    tmp_path = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    tmp_path.write_text(content, encoding=encoding)
    os.replace(tmp_path, path)


def _scenario_path(scenario_id: str) -> Path:
    """scenario_id becomes a filename directly, so reject path traversal (e.g. `../../etc`) instead of trying to sanitize it."""
    if not _SAFE_SCENARIO_ID.match(scenario_id):
        raise ValueError(f"invalid scenario_id: {scenario_id!r} (letters, digits, _ and - only)")
    return SCENARIOS_DIR / f"{scenario_id}.json"


class ScenarioEventDto(BaseModel):
    time: float
    device_id: str
    parameters: dict


class ScenarioFileDto(BaseModel):
    """POST /scenarios/{scenario_id} body: `events` is what PLAY_SCENARIO/load_scenario actually reads; `device_ids` is opaque editor-only state (which zone devices to show) the daemon just stores and round-trips."""
    name: str
    duration: float
    events: list[ScenarioEventDto]
    music_file: Optional[str] = None
    device_ids: list[str] = []


async def save_installation(zones: dict[int, ZoneRuntime]) -> None:
    # Write runs in an executor because a slow/contended disk would otherwise stall the same event loop driving the 50ms hardware tick.
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "zones": [
            {
                "zone_id": zone_id,
                "name": zone.name,
                "driver_instances": [
                    {
                        "instance_id": instance_id,
                        "driver_type": zone.instance_driver_types[instance_id],
                        "config": zone.instance_configs[instance_id],
                    }
                    for instance_id in zone.driver_instances
                ],
                "devices": [
                    {
                        "device_id": device_id, "instance_id": instance_id, "channel": channel,
                        "nozzle_group": zone.device_nozzle_info.get(device_id, (None, None))[0],
                        "nozzle_inverter": zone.device_nozzle_info.get(device_id, (None, None))[1],
                    }
                    for device_id, (instance_id, channel) in zone.device_map.items()
                ],
            }
            for zone_id, zone in zones.items()
        ]
    }
    try:
        await asyncio.get_running_loop().run_in_executor(
            None, _write_text_atomic, INSTALLATION_FILE, json.dumps(payload, indent=2),
        )
    except OSError as exc:
        # Must not crash the daemon -- better a config that doesn't survive restart than the triggering command taking down the process.
        logger.error("failed to write %s: %s", INSTALLATION_FILE, exc)


async def load_installation(get_zone: Callable[[int], ZoneRuntime]) -> list[tuple[int, str, DriverInstance]]:
    """Registers zones/instances/devices from installation.json without connecting to hardware, returning them for the caller (main.py's lifespan) to connect concurrently in the background -- connecting synchronously here would block the ASGI server, including the HMI's WS handshake, until every configured board connected or timed out, one by one."""
    if not INSTALLATION_FILE.exists():
        logger.info("no %s found, starting with no configured hardware", INSTALLATION_FILE)
        return []

    try:
        payload = json.loads(INSTALLATION_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        logger.error("failed to read %s: %s -- starting with no configured hardware", INSTALLATION_FILE, exc)
        return []

    pending_connects: list[tuple[int, str, DriverInstance]] = []

    for zone_data in payload.get("zones", []):
        zone = get_zone(zone_data["zone_id"])
        zone.rename(zone_data.get("name"))

        for instance in zone_data.get("driver_instances", []):
            try:
                await zone.add_driver_instance(instance["instance_id"], instance["driver_type"], instance["config"], connect=False)
                pending_connects.append((zone_data["zone_id"], instance["instance_id"], zone.driver_instances[instance["instance_id"]]))
            except KeyError as exc:
                logger.error("zone %s: skipping instance %s, unknown driver_type: %s",
                             zone_data["zone_id"], instance["instance_id"], exc)

        for device in zone_data.get("devices", []):
            await zone.add_device(
                device["device_id"], device["instance_id"], device["channel"],
                device.get("nozzle_group"), device.get("nozzle_inverter"),
            )

    logger.info("loaded installation config: %d zone(s)", len(payload.get("zones", [])))
    return pending_connects


def _list_scenarios_sync() -> list[dict]:
    if not SCENARIOS_DIR.exists():
        return []
    scenarios = []
    for path in sorted(SCENARIOS_DIR.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("skipping unreadable scenario file %s: %s", path, exc)
            continue
        scenarios.append({
            "scenario_id": path.stem,
            "name": data.get("name", path.stem),
            "duration": data.get("duration", 0.0),
        })
    return scenarios


async def list_scenarios() -> list[dict]:
    # Runs in an executor for the same reason as save_installation: globbing/reading every scenario file would otherwise block the 50ms hardware tick.
    return await asyncio.get_running_loop().run_in_executor(None, _list_scenarios_sync)


def _backup_and_write_scenario(path: Path, scenario_id: str, content: str) -> None:
    """Backs up the file being overwritten (the timeline UI has no undo across a reload) under SCENARIOS_DIR/.backups/, pruned to the last MAX_BACKUPS_PER_SCENARIO as a safety net, not full edit history."""
    if path.exists():
        backups_dir = SCENARIO_BACKUPS_DIR / scenario_id
        backups_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%dT%H%M%S")
        shutil.copy2(path, backups_dir / f"{stamp}.json")
        stale = sorted(backups_dir.glob("*.json"))[:-MAX_BACKUPS_PER_SCENARIO]
        for old in stale:
            old.unlink(missing_ok=True)
    _write_text_atomic(path, content)


async def save_scenario(scenario_id: str, data: ScenarioFileDto) -> None:
    """Async so the timeline UI's Save (a REST call, but on the same event loop) can't stall a playing show's tick loop on disk I/O."""
    SCENARIOS_DIR.mkdir(parents=True, exist_ok=True)
    path = _scenario_path(scenario_id)
    await asyncio.get_running_loop().run_in_executor(
        None, _backup_and_write_scenario, path, scenario_id, data.model_dump_json(indent=2),
    )


def _delete_scenario_sync(scenario_id: str) -> None:
    path = _scenario_path(scenario_id)
    if not path.exists():
        raise FileNotFoundError(f"scenario '{scenario_id}' not found ({path})")
    path.unlink()


async def delete_scenario(scenario_id: str) -> None:
    await asyncio.get_running_loop().run_in_executor(None, _delete_scenario_sync, scenario_id)


def _read_scenario_raw_sync(scenario_id: str) -> dict:
    path = _scenario_path(scenario_id)
    if not path.exists():
        raise FileNotFoundError(f"scenario '{scenario_id}' not found ({path})")
    return json.loads(path.read_text(encoding="utf-8"))


async def read_scenario_raw(scenario_id: str) -> dict:
    """Returns the raw saved JSON for the editor to reload -- unlike load_scenario()'s `Project`, which resolves music_file to an absolute path and drops `name`."""
    return await asyncio.get_running_loop().run_in_executor(None, _read_scenario_raw_sync, scenario_id)


def resolve_music_path(music_file: str) -> Path:
    """Relative music_file paths resolve under SCENARIOS_DIR (for portability) and are sandboxed against `../` traversal since this is reachable from untrusted input (GET /audio?path=, scenario files); absolute paths (e.g. from the HMI's native file picker) are intentionally passed through as-is."""
    path = Path(music_file)
    if path.is_absolute():
        return path.resolve()

    resolved = (SCENARIOS_DIR / path).resolve()
    scenarios_root = SCENARIOS_DIR.resolve()
    if resolved != scenarios_root and scenarios_root not in resolved.parents:
        raise ValueError(f"invalid music_file: {music_file!r} (escapes the scenarios folder)")
    return resolved


def _load_scenario_sync(scenario_id: str) -> Project:
    path = _scenario_path(scenario_id)
    if not path.exists():
        raise FileNotFoundError(f"scenario '{scenario_id}' not found ({path})")

    data = json.loads(path.read_text(encoding="utf-8"))
    events = [Event(time=e["time"], device_id=e["device_id"], parameters=e.get("parameters", {})) for e in data["events"]]

    music_file = data.get("music_file")
    if music_file:
        music_file = str(resolve_music_path(music_file))

    return Project(duration=data["duration"], events=events, music_file=music_file)


async def load_scenario(scenario_id: str) -> Project:
    # Runs in an executor: a synchronous read here would stall the 50ms hardware tick right as a show is starting.
    return await asyncio.get_running_loop().run_in_executor(None, _load_scenario_sync, scenario_id)


# -- audit log ---------------------------------------------------------------
# No per-operator identity on this shared panel, so this logs "what happened when" (every command, accepted or rejected), not "who" -- append-only JSON Lines so reading recent history doesn't require parsing one giant array.


def _append_audit_entry_sync(line: str) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    try:
        if AUDIT_LOG_FILE.exists() and AUDIT_LOG_FILE.stat().st_size > AUDIT_LOG_MAX_BYTES:
            backup = AUDIT_LOG_FILE.with_suffix(".log.1")
            backup.unlink(missing_ok=True)
            AUDIT_LOG_FILE.rename(backup)
    except OSError as exc:
        logger.warning("failed to rotate %s: %s", AUDIT_LOG_FILE, exc)
    with open(AUDIT_LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")


async def append_audit_entry(command: str, zone_id: int | None, ok: bool, error: str | None) -> None:
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "command": command,
        "zone_id": zone_id,
        "ok": ok,
        "error": error,
    }
    try:
        await asyncio.get_running_loop().run_in_executor(None, _append_audit_entry_sync, json.dumps(entry))
    except OSError as exc:
        # Same stance as save_installation: a failed audit write must not take a hardware command down with it.
        logger.error("failed to write %s: %s", AUDIT_LOG_FILE, exc)


def _read_audit_log_sync(limit: int) -> list[dict]:
    if not AUDIT_LOG_FILE.exists():
        return []
    entries = []
    for line in AUDIT_LOG_FILE.read_text(encoding="utf-8").splitlines()[-limit:]:
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    entries.reverse()
    return entries


async def read_audit_log(limit: int = 200) -> list[dict]:
    """Most recent entries first -- what an operator reviewing an incident wants to see without scrolling."""
    return await asyncio.get_running_loop().run_in_executor(None, _read_audit_log_sync, limit)


# -- scheduled playback --------------------------------------------------------
# Separate file from installation.json: a schedule entry isn't "what's wired to what" and changes on its own cadence (an operator tweaking show times, not hardware).


class ScheduleEntryDto(BaseModel):
    id: str
    zone_id: int
    scenario_id: str
    time: str = Field(pattern=_TIME_OF_DAY.pattern)  # "HH:MM", 24h, local time
    days: list[int] = []  # 0=Monday..6=Sunday; empty = every day
    enabled: bool = True
    # "YYYY-MM-DD" it last fired -- the only guard against firing twice in the same matching minute (checked every 20s) or repeatedly while the daemon restarts; a missed time is never caught up.
    last_fired_date: Optional[str] = None


class ScheduleEntryCreateDto(BaseModel):
    zone_id: int
    scenario_id: str
    time: str = Field(pattern=_TIME_OF_DAY.pattern)
    days: list[int] = []
    enabled: bool = True


class ScheduleEntryUpdateDto(BaseModel):
    zone_id: Optional[int] = None
    scenario_id: Optional[str] = None
    time: Optional[str] = Field(default=None, pattern=_TIME_OF_DAY.pattern)
    days: Optional[list[int]] = None
    enabled: Optional[bool] = None


def _load_schedule_sync() -> list[ScheduleEntryDto]:
    if not SCHEDULE_FILE.exists():
        return []
    try:
        payload = json.loads(SCHEDULE_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        logger.error("failed to read %s: %s -- starting with no schedule", SCHEDULE_FILE, exc)
        return []
    return [ScheduleEntryDto.model_validate(e) for e in payload]


async def load_schedule() -> list[ScheduleEntryDto]:
    # Read on every GET /schedule and every 20s _check_schedule pass -- same event-loop-blocking concern as the others above.
    return await asyncio.get_running_loop().run_in_executor(None, _load_schedule_sync)


async def save_schedule(entries: list[ScheduleEntryDto]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    content = json.dumps([e.model_dump() for e in entries], indent=2)
    await asyncio.get_running_loop().run_in_executor(None, _write_text_atomic, SCHEDULE_FILE, content)
