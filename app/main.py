"""FastAPI ASGI daemon (one WS for commands/events, a few REST endpoints); client input or a flaky Modbus link must always yield Ack(ok=False)/HardwareErrorEvent, never an unhandled exception that kills the WS or process."""
from __future__ import annotations

import asyncio
import logging
import time
from contextlib import asynccontextmanager, suppress
from datetime import datetime
from uuid import uuid4

import uvicorn
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import TypeAdapter, ValidationError

from app import config
from app import drivers as _drivers  # noqa: F401 -- side-effect import, registers every built-in driver
from app import persistence
from app.drivers.base import DeviceCategory, DriverInstance, list_drivers
from app.event_bus import EventBus
from app.protocol import Ack, Command, HeartbeatEvent
from app.zone_runtime import ZoneRuntime

_command_adapter = TypeAdapter(Command)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("fountain.main")

bus = EventBus()
zones: dict[int, ZoneRuntime] = {}


def get_zone(zone_id: int) -> ZoneRuntime:
    if zone_id not in zones:
        zones[zone_id] = ZoneRuntime(zone_id, bus)
    return zones[zone_id]


_SCHEDULE_CHECK_INTERVAL_S = 20.0


async def _check_schedule() -> None:
    """last_fired_date guards against double-firing within the same matching minute at this poll interval; a missed time (daemon was down) is skipped, not caught up -- see ScheduleEntryDto."""
    entries = await persistence.load_schedule()
    now = datetime.now()
    today = now.strftime("%Y-%m-%d")
    current_time = now.strftime("%H:%M")
    weekday = now.weekday()  # 0=Monday .. 6=Sunday, matches ScheduleEntryDto.days

    changed = False
    for entry in entries:
        if not entry.enabled or entry.time != current_time or entry.last_fired_date == today:
            continue
        if entry.days and weekday not in entry.days:
            continue

        entry.last_fired_date = today  # set before the attempt -- a hardware failure must not retry every 20s
        changed = True
        try:
            zone = get_zone(entry.zone_id)
            project = await persistence.load_scenario(entry.scenario_id)
            zone.player.load_project(project, entry.scenario_id)
            await zone.player.play()
            logger.info("schedule: zone %s playing '%s' (scheduled %s)", entry.zone_id, entry.scenario_id, entry.time)
            await persistence.append_audit_entry("SCHEDULED_PLAY", entry.zone_id, True, None)
        except Exception as exc:  # noqa: BLE001 - one bad entry must not stop the rest, or crash this loop
            logger.exception("scheduled play failed for entry %s (zone %s, scenario '%s')",
                              entry.id, entry.zone_id, entry.scenario_id)
            await persistence.append_audit_entry("SCHEDULED_PLAY", entry.zone_id, False, str(exc))

    if changed:
        await persistence.save_schedule(entries)


async def _schedule_loop() -> None:
    while True:
        await asyncio.sleep(_SCHEDULE_CHECK_INTERVAL_S)
        try:
            await _check_schedule()
        except Exception:
            logger.exception("schedule check failed")


async def _emergency_stop_all_zones() -> None:
    """Forces every zone off on any daemon exit, since the watchdog and everything else guarding the hardware dies with this process; called from both lifespan shutdown and POST /shutdown (see its docstring)."""
    if not zones:
        return
    logger.info("emergency-stopping %d zone(s)", len(zones))
    await asyncio.gather(*(z.emergency_stop() for z in zones.values()), return_exceptions=True)


async def _connect_pending_instances(pending: list[tuple[int, str, DriverInstance]]) -> None:
    """Connects instances persistence.load_installation registered but didn't dial out for, concurrently in the background (see that docstring); drivers already publish HardwareErrorEvent/ConnectionStateEvent on failure, so this only adds a startup log line."""
    if not pending:
        return
    results = await asyncio.gather(*(instance.connect() for _, _, instance in pending), return_exceptions=True)
    for (zone_id, instance_id, _), result in zip(pending, results):
        if isinstance(result, Exception):
            logger.exception("zone %s: instance %s failed to connect at startup", zone_id, instance_id, exc_info=result)
        elif not result:
            logger.warning(
                "zone %s: instance %s did not connect at startup, its own reconnect watchdog will keep retrying",
                zone_id, instance_id,
            )


@asynccontextmanager
async def lifespan(_: FastAPI):
    pending_connects = await persistence.load_installation(get_zone)
    # Not awaited here: an unreachable/slow board would otherwise block the whole ASGI server (incl. the HMI's WS handshake) until every instance connected or timed out.
    connect_task = asyncio.create_task(_connect_pending_instances(pending_connects))
    schedule_task = asyncio.create_task(_schedule_loop())
    yield
    connect_task.cancel()
    schedule_task.cancel()
    # Must await both cancellations before _emergency_stop_all_zones(): either task can still be mid-flight after cancel() returns, and could otherwise re-arm a zone right as it's being stopped.
    with suppress(asyncio.CancelledError):
        await connect_task
    with suppress(asyncio.CancelledError):
        await schedule_task
    await _emergency_stop_all_zones()


app = FastAPI(title="Fountain Control Daemon", lifespan=lifespan)

# 127.0.0.1 binding stops the network, not a local browser tab -- CORS must be restricted to config.ALLOWED_ORIGINS (also used for the WS handshake below, which CORS itself doesn't cover) and allow_methods must include non-GET verbs or preflight silently breaks Save/Delete while read-only screens keep working.
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "zones_active": list(zones.keys())}


@app.post("/shutdown")
async def shutdown() -> dict:
    """Called by the Electron shell before it kills this process: on Windows, ChildProcess.kill() doesn't reliably let asyncio's signal handlers (which lifespan shutdown depends on) run, so this guarantees hardware is off before that kill lands."""
    await _emergency_stop_all_zones()
    return {"status": "ok"}


@app.get("/zones")
async def get_zones() -> list[dict]:
    """The HMI fetches this on connect/reconnect to rehydrate its device-config screen from the daemon, the source of truth, rather than only what it sent this session."""
    result = []
    for zone_id, zone in zones.items():
        instances = [
            {
                "instance_id": instance_id,
                "driver_type": zone.instance_driver_types[instance_id],
                "category": zone.instance_categories[instance_id].value,
                "connected": instance.is_connected(),
                "config": zone.instance_configs[instance_id],
            }
            for instance_id, instance in zone.driver_instances.items()
        ]
        devices = [
            {
                "device_id": device_id, "instance_id": instance_id, "channel": channel,
                "category": zone.device_categories[device_id].value,
                "nozzle_group": zone.device_nozzle_info.get(device_id, (None, None))[0],
                "nozzle_inverter": zone.device_nozzle_info.get(device_id, (None, None))[1],
            }
            for device_id, (instance_id, channel) in zone.device_map.items()
        ]
        result.append({
            "zone_id": zone_id, "name": zone.name, "driver_instances": instances, "devices": devices,
            # Runtime-only, never persisted -- this GET is the only way for the HMI's sliders to learn the current value on reload/reconnect instead of assuming 100%.
            "global_brightness": round(zone.global_brightness * 100),
            "global_speed": round(zone.global_speed * 100),
        })
    return result


@app.get("/drivers")
async def get_drivers() -> list[dict]:
    """`config_schema` is the driver's Pydantic config model as JSON Schema, so the frontend can build the config form dynamically instead of hardcoding fields per driver type."""
    return [
        {
            "driver_type": d.driver_type,
            "category": d.category.value,
            "display_name": d.display_name,
            "config_schema": d.config_model.model_json_schema(),
        }
        for d in list_drivers()
    ]


@app.get("/scenarios")
async def get_scenarios() -> list[dict]:
    """Read-only listing of scenario files on disk (data/scenarios/*.json)."""
    return await persistence.list_scenarios()


@app.get("/scenarios/{scenario_id}")
async def get_scenario(scenario_id: str) -> dict:
    """Full content for the timeline UI to edit -- GET reads exactly what POST (below) writes."""
    try:
        return await persistence.read_scenario_raw(scenario_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/audio")
async def get_audio(path: str) -> FileResponse:
    """Serves a music_file's raw bytes for the timeline UI to decode client-side (Web Audio API) and draw a waveform; uses the same path resolution as playback so a relative path means the same file that actually plays."""
    try:
        resolved = persistence.resolve_music_path(path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not resolved.is_file():
        raise HTTPException(status_code=404, detail=f"audio file not found: {path}")
    return FileResponse(resolved)


@app.post("/scenarios/{scenario_id}")
async def put_scenario(scenario_id: str, payload: persistence.ScenarioFileDto) -> dict:
    """Plain file write, not a WS command -- this is CRUD on a file, not a runtime hardware mutation."""
    try:
        await persistence.save_scenario(scenario_id, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": "ok", "scenario_id": scenario_id}


@app.delete("/scenarios/{scenario_id}")
async def delete_scenario(scenario_id: str) -> dict:
    """A currently-playing scenario is unaffected: PLAY_SCENARIO reads the file once at play-start into an in-memory Project and never re-reads it, so deleting it mid-playback can't interrupt a running show."""
    try:
        await persistence.delete_scenario(scenario_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"status": "ok", "scenario_id": scenario_id}


@app.get("/schedule")
async def get_schedule() -> list[dict]:
    return [e.model_dump() for e in await persistence.load_schedule()]


@app.post("/schedule")
async def create_schedule_entry(payload: persistence.ScheduleEntryCreateDto) -> dict:
    entries = await persistence.load_schedule()
    entry = persistence.ScheduleEntryDto(id=str(uuid4()), **payload.model_dump())
    entries.append(entry)
    await persistence.save_schedule(entries)
    return entry.model_dump()


@app.put("/schedule/{entry_id}")
async def update_schedule_entry(entry_id: str, payload: persistence.ScheduleEntryUpdateDto) -> dict:
    entries = await persistence.load_schedule()
    for i, entry in enumerate(entries):
        if entry.id == entry_id:
            # exclude_unset: a field the client omitted must keep its current value, not reset to the DTO's default (e.g. bool `enabled` defaulting to True would silently re-enable a disabled entry).
            updated = entry.model_copy(update=payload.model_dump(exclude_unset=True))
            entries[i] = updated
            await persistence.save_schedule(entries)
            return updated.model_dump()
    raise HTTPException(status_code=404, detail=f"schedule entry '{entry_id}' not found")


@app.delete("/schedule/{entry_id}")
async def delete_schedule_entry(entry_id: str) -> dict:
    entries = await persistence.load_schedule()
    remaining = [e for e in entries if e.id != entry_id]
    if len(remaining) == len(entries):
        raise HTTPException(status_code=404, detail=f"schedule entry '{entry_id}' not found")
    await persistence.save_schedule(remaining)
    return {"status": "ok"}


@app.get("/audit")
async def get_audit_log(limit: int = 200) -> list[dict]:
    return await persistence.read_audit_log(limit=limit)


@app.websocket(config.WS_PATH)
async def ws_endpoint(websocket: WebSocket) -> None:
    # CORS doesn't cover WebSocket at all, so without this any local browser tab could open this hardware-control socket directly; a missing Origin (non-browser tools) is let through since blocking it would need real auth.
    origin = websocket.headers.get("origin")
    if origin is not None and origin not in config.ALLOWED_ORIGINS:
        logger.warning("rejected WS connection from disallowed origin: %s", origin)
        await websocket.close(code=1008)
        return

    await websocket.accept()
    sub_queue = bus.subscribe()

    async def reader() -> None:
        while True:
            raw = await websocket.receive_text()
            await _handle_incoming(websocket, raw)

    async def writer() -> None:
        while True:
            event = await sub_queue.get()
            await websocket.send_text(event.model_dump_json())

    async def heartbeat() -> None:
        while True:
            await asyncio.sleep(5.0)
            bus.publish(HeartbeatEvent(ts=time.time()))

    tasks = [asyncio.create_task(reader()), asyncio.create_task(writer()), asyncio.create_task(heartbeat())]
    try:
        # asyncio.wait() never raises a task's exception, so each done task's result must be pulled explicitly to tell a routine WebSocketDisconnect from an actual bug worth logging.
        done, _pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            exc = task.exception()
            if exc is not None and not isinstance(exc, WebSocketDisconnect):
                logger.exception("WS connection task failed", exc_info=exc)
    finally:
        for task in tasks:
            task.cancel()
        bus.unsubscribe(sub_queue)


async def _handle_incoming(websocket: WebSocket, raw: str) -> None:
    try:
        cmd = _command_adapter.validate_json(raw)
    except ValidationError as exc:
        # No command id available yet -- can't correlate an Ack, so report as a bare error.
        await _send_ack(websocket, Ack(id="unknown", ok=False, error=f"invalid command: {exc}"))
        return

    try:
        await _dispatch(cmd)
        ack = Ack(id=cmd.id, ok=True)
    except Exception as exc:  # noqa: BLE001 - a bad command must not take the connection down
        logger.exception("command %s failed", cmd.command)
        ack = Ack(id=cmd.id, ok=False, error=str(exc))

    await persistence.append_audit_entry(cmd.command, getattr(cmd, "zone_id", None), ack.ok, ack.error)
    await _send_ack(websocket, ack)


async def _send_ack(websocket: WebSocket, ack: Ack) -> None:
    """A slow command can outlive the client's connection; swallowing the send failure here (rather than letting it raise) avoids killing the reader task and, with it, this connection's writer/heartbeat."""
    try:
        await websocket.send_text(ack.model_dump_json())
    except Exception:  # noqa: BLE001
        logger.debug("could not send Ack(id=%s) -- client likely disconnected", ack.id)


async def _dispatch(cmd) -> None:  # noqa: ANN001 - discriminated union, see app/protocol.py
    match cmd.command:
        case "CONNECT_ZONE":
            zone = get_zone(cmd.zone_id)
            categories = {DeviceCategory(t) for t in cmd.device_types} if cmd.device_types else None
            await zone.connect_all(categories)

        case "DISCONNECT_ZONE":
            if cmd.zone_id in zones:
                await zones[cmd.zone_id].disconnect()

        case "RENAME_ZONE":
            get_zone(cmd.zone_id).rename(cmd.name)
            await persistence.save_installation(zones)

        case "DELETE_ZONE":
            if cmd.zone_id in zones:
                await zones[cmd.zone_id].disconnect()
                del zones[cmd.zone_id]
                await persistence.save_installation(zones)

        case "ADD_DRIVER_INSTANCE":
            zone = get_zone(cmd.zone_id)
            # Registers even if connect fails (reported via HardwareErrorEvent, not a failed Ack) since configuring unreachable hardware is normal setup; an unknown driver_type still raises as a real config mistake.
            await zone.add_driver_instance(cmd.instance_id, cmd.driver_type, cmd.config)
            await persistence.save_installation(zones)

        case "REMOVE_DRIVER_INSTANCE":
            if cmd.zone_id in zones:
                await zones[cmd.zone_id].remove_driver_instance(cmd.instance_id)
                await persistence.save_installation(zones)

        case "ADD_DEVICE":
            zone = get_zone(cmd.zone_id)
            if not await zone.add_device(cmd.device_id, cmd.instance_id, cmd.channel, cmd.nozzle_group, cmd.nozzle_inverter):
                raise RuntimeError(f"failed to add device '{cmd.device_id}': unknown instance '{cmd.instance_id}'")
            await persistence.save_installation(zones)

        case "REMOVE_DEVICE":
            if cmd.zone_id in zones:
                zones[cmd.zone_id].remove_device(cmd.device_id)
                await persistence.save_installation(zones)

        case "PLAY_SCENARIO":
            zone = get_zone(cmd.zone_id)
            project = await persistence.load_scenario(cmd.scenario_id)  # raises FileNotFoundError -> Ack(ok=False)
            zone.player.load_project(project, cmd.scenario_id)
            await zone.player.play()

        case "STOP_ZONE":
            if cmd.zone_id in zones:
                await zones[cmd.zone_id].player.stop()

        case "PAUSE_ZONE":
            if cmd.zone_id in zones:
                await zones[cmd.zone_id].player.pause()

        case "SEEK_ZONE":
            if cmd.zone_id in zones:
                await zones[cmd.zone_id].player.seek(cmd.position)

        case "SET_LOOP":
            if cmd.zone_id in zones:
                zones[cmd.zone_id].player.is_looping = cmd.enabled

        case "SET_GLOBAL_BRIGHTNESS":
            if cmd.zone_id in zones:
                zones[cmd.zone_id].set_global_brightness(cmd.value)

        case "SET_GLOBAL_SPEED":
            if cmd.zone_id in zones:
                zones[cmd.zone_id].set_global_speed(cmd.value)

        case "EMERGENCY_STOP":
            targets = [zones[cmd.zone_id]] if cmd.zone_id is not None and cmd.zone_id in zones else list(zones.values())
            await asyncio.gather(*(z.emergency_stop() for z in targets))

        case "RECONNECT_INSTANCE":
            # Unlike CONNECT_ZONE et al., there's no legitimate "first time we've heard of this zone" case here, so get_zone() would silently create a permanent zombie zone for a typo'd/stale zone_id.
            if cmd.zone_id not in zones:
                raise RuntimeError(f"unknown zone {cmd.zone_id}")
            await zones[cmd.zone_id].reconnect_instance(cmd.instance_id)

        case "SET_DEVICE_STATE":
            if cmd.zone_id not in zones:  # see RECONNECT_INSTANCE above
                raise RuntimeError(f"unknown zone {cmd.zone_id}")
            zones[cmd.zone_id].set_device_state(cmd.device_id, cmd.parameters)

        case "RESET_MOTOR_FAULT":
            if cmd.zone_id not in zones:  # see RECONNECT_INSTANCE above
                raise RuntimeError(f"unknown zone {cmd.zone_id}")
            if not await zones[cmd.zone_id].reset_motor_fault(cmd.device_id):
                raise RuntimeError(f"fault reset failed for '{cmd.device_id}'")


def run() -> None:
    uvicorn.run(app, host=config.HOST, port=config.PORT, log_level="info")


if __name__ == "__main__":
    run()
