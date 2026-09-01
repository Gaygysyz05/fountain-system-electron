"""
File-backed persistence, deliberately split in two per the architecture
discussion:

  - Installation config (zones -> driver instances -> devices): what's
    physically wired to what. Reconfigured rarely. Saved automatically after
    every ADD/REMOVE command, loaded once at daemon startup so it reconnects
    to whatever hardware it already knew about (retrying in the background
    via each driver's own watchdog if something isn't reachable yet).
  - Scenarios (a timeline of events referencing device_id): authored/changed
    often. Nothing in this codebase writes them yet -- that's the future
    timeline UI's job -- so only loading is implemented here. One JSON file
    per scenario under SCENARIOS_DIR.

Coupling these into one file would mean re-saving the whole hardware
configuration every time a show's timeline changes, and vice versa -- a
relay bank's IP address and a light cue at t=12.5s have nothing to do with
each other and shouldn't live in the same blob.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from pathlib import Path
from typing import Callable, Optional

from pydantic import BaseModel

from app.zone_runtime import ZoneRuntime
from app.zones.models import Event, Project

logger = logging.getLogger("fountain.persistence")

DATA_DIR = Path("data")
INSTALLATION_FILE = DATA_DIR / "installation.json"
SCENARIOS_DIR = DATA_DIR / "scenarios"

_SAFE_SCENARIO_ID = re.compile(r"^[A-Za-z0-9_-]+$")


def _write_text_atomic(path: Path, content: str, encoding: str = "utf-8") -> None:
    """write_text() truncates the target before writing its new content --
    a crash or power loss mid-write (this daemon rewrites installation.json
    on every ADD_DEVICE/ADD_DRIVER_INSTANCE/etc., on hardware that's more
    exposed to hard power-cuts than a typical server) leaves a truncated,
    unparseable file. load_installation() then discards the ENTIRE wiring
    config and silently starts with no configured hardware. Writing to a
    temp file in the same directory (so the rename below stays on one
    filesystem) and renaming over the target is atomic on both POSIX and
    Windows: the target is either the old complete content or the new
    complete content, never a partial write."""
    tmp_path = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    tmp_path.write_text(content, encoding=encoding)
    os.replace(tmp_path, path)


def _scenario_path(scenario_id: str) -> Path:
    """scenario_id becomes a filename directly -- reject anything that could
    walk out of SCENARIOS_DIR (e.g. `../../etc`) rather than sanitizing it."""
    if not _SAFE_SCENARIO_ID.match(scenario_id):
        raise ValueError(f"invalid scenario_id: {scenario_id!r} (letters, digits, _ and - only)")
    return SCENARIOS_DIR / f"{scenario_id}.json"


class ScenarioEventDto(BaseModel):
    time: float
    device_id: str
    parameters: dict


class ScenarioFileDto(BaseModel):
    """Request body for POST /scenarios/{scenario_id} -- the timeline UI's
    save action. Validated here so a malformed save fails with a clear 422
    instead of writing a scenario file the daemon can't load back.

    `events` is what PLAY_SCENARIO actually reads (load_scenario, below) --
    the flat device_id+time+parameters list the scheduler has always
    understood; the editor authors it directly (component_tables.py-style
    dense per-device/per-step tables, one per device category), no
    intermediate authoring structure. `device_ids` is the one piece of
    editor-only state that rides along: which zone devices this scenario's
    tabs should show. The daemon treats it as opaque JSON: it never reads
    its contents, only stores and returns it so the editor can round-trip a
    scenario without losing its device selection on reload."""
    name: str
    duration: float
    events: list[ScenarioEventDto]
    music_file: Optional[str] = None
    device_ids: list[str] = []


async def save_installation(zones: dict[int, ZoneRuntime]) -> None:
    # Called from every ADD_DEVICE/ADD_DRIVER_INSTANCE/RENAME_ZONE/REMOVE_*
    # command handler in main.py, on the same event loop that also runs the
    # 50ms scenario tick and all Modbus/Art-Net I/O -- a plain synchronous
    # write_text() blocks that entire loop for the write's duration. Small
    # file, fast disk, rarely matters -- but on a slow/contended disk (a USB
    # installer drive, say) it directly stalls hardware ticks and heartbeats
    # while a save is in flight, which a real-time control system shouldn't
    # do for something as incidental as persisting config. run_in_executor
    # moves the actual write off the loop; everything else here (building
    # the payload dict) is cheap, in-memory, and left synchronous.
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
        # A failed save must not take the daemon down -- the operator will
        # notice their config didn't survive a restart, which is bad, but
        # far better than the command that triggered this crashing the process.
        logger.error("failed to write %s: %s", INSTALLATION_FILE, exc)


async def load_installation(get_zone: Callable[[int], ZoneRuntime]) -> None:
    if not INSTALLATION_FILE.exists():
        logger.info("no %s found, starting with no configured hardware", INSTALLATION_FILE)
        return

    try:
        payload = json.loads(INSTALLATION_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        logger.error("failed to read %s: %s -- starting with no configured hardware", INSTALLATION_FILE, exc)
        return

    for zone_data in payload.get("zones", []):
        zone = get_zone(zone_data["zone_id"])
        zone.rename(zone_data.get("name"))

        for instance in zone_data.get("driver_instances", []):
            try:
                ok = await zone.add_driver_instance(instance["instance_id"], instance["driver_type"], instance["config"])
                if not ok:
                    logger.warning(
                        "zone %s: instance %s did not connect at startup, its own reconnect watchdog will keep retrying",
                        zone_data["zone_id"], instance["instance_id"],
                    )
            except KeyError as exc:
                logger.error("zone %s: skipping instance %s, unknown driver_type: %s",
                             zone_data["zone_id"], instance["instance_id"], exc)

        for device in zone_data.get("devices", []):
            await zone.add_device(
                device["device_id"], device["instance_id"], device["channel"],
                device.get("nozzle_group"), device.get("nozzle_inverter"),
            )

    logger.info("loaded installation config: %d zone(s)", len(payload.get("zones", [])))


def list_scenarios() -> list[dict]:
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


async def save_scenario(scenario_id: str, data: ScenarioFileDto) -> None:
    """Async for the same reason as save_installation above -- the timeline
    UI's Save action shouldn't be able to stall a playing show's tick loop
    on disk I/O, even though it's a REST call, not a WS command: both run
    on the very same event loop."""
    SCENARIOS_DIR.mkdir(parents=True, exist_ok=True)
    await asyncio.get_running_loop().run_in_executor(
        None, _write_text_atomic, _scenario_path(scenario_id), data.model_dump_json(indent=2),
    )


def delete_scenario(scenario_id: str) -> None:
    path = _scenario_path(scenario_id)
    if not path.exists():
        raise FileNotFoundError(f"scenario '{scenario_id}' not found ({path})")
    path.unlink()


def read_scenario_raw(scenario_id: str) -> dict:
    """Full file content for the timeline UI to load back into its editor --
    the raw JSON as saved, NOT the runtime `Project` from load_scenario()
    (that one resolves music_file to an absolute path and drops `name`
    entirely, neither of which the editor should see or re-save)."""
    path = _scenario_path(scenario_id)
    if not path.exists():
        raise FileNotFoundError(f"scenario '{scenario_id}' not found ({path})")
    return json.loads(path.read_text(encoding="utf-8"))


def resolve_music_path(music_file: str) -> Path:
    """Relative to data/scenarios/, not the daemon's cwd -- so the whole
    scenarios folder (and the audio files an operator drops alongside it)
    stays portable if copied to another machine. Used both when the daemon
    plays a scenario's track (load_scenario, below) and when the timeline
    UI asks to preview/waveform one (GET /audio in main.py) -- one place
    that decides what a music_file string means.

    An absolute path (e.g. picked via the HMI's native file dialog from
    outside the scenarios folder, see main/index.ts's select-music-file) is
    intentionally allowed through as-is -- that's a deliberate feature, not
    a gap. A RELATIVE one is sandboxed to stay inside SCENARIOS_DIR, same
    principle as _scenario_path's regex: this is reachable from an
    untrusted REST param (GET /audio?path=) as well as a scenario file's
    own music_file field, and `../../anything` has no legitimate reason to
    appear in a relative music_file."""
    path = Path(music_file)
    if path.is_absolute():
        return path.resolve()

    resolved = (SCENARIOS_DIR / path).resolve()
    scenarios_root = SCENARIOS_DIR.resolve()
    if resolved != scenarios_root and scenarios_root not in resolved.parents:
        raise ValueError(f"invalid music_file: {music_file!r} (escapes the scenarios folder)")
    return resolved


def load_scenario(scenario_id: str) -> Project:
    path = _scenario_path(scenario_id)
    if not path.exists():
        raise FileNotFoundError(f"scenario '{scenario_id}' not found ({path})")

    data = json.loads(path.read_text(encoding="utf-8"))
    events = [Event(time=e["time"], device_id=e["device_id"], parameters=e.get("parameters", {})) for e in data["events"]]

    music_file = data.get("music_file")
    if music_file:
        music_file = str(resolve_music_path(music_file))

    return Project(duration=data["duration"], events=events, music_file=music_file)
