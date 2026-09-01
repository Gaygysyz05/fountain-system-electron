"""
FastAPI daemon entrypoint. Replaces PyQt6's ZoneFountainEditor/SuperPlayer event
loop and api_server.py's Flask thread with a single ASGI app on one asyncio
event loop: one WebSocket for commands in + status/events out, plus a couple of
read-only REST endpoints for things that are naturally request/response.

Error-handling stance (per the brief): a malformed command, an unknown zone, or
a hardware exception must produce an Ack(ok=False) or a HardwareErrorEvent on
the bus -- never an unhandled exception that kills the WS connection or the
process. The only things allowed to actually crash the daemon are bugs in this
file's own control flow, not anything reachable from client input or a flaky
Modbus link.
"""
from __future__ import annotations

import asyncio
import logging
import time
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import TypeAdapter, ValidationError

from app import config
from app import drivers as _drivers  # noqa: F401 -- side-effect import, registers every built-in driver
from app import persistence
from app.drivers.base import DeviceCategory, list_drivers
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


@asynccontextmanager
async def lifespan(_: FastAPI):
    await persistence.load_installation(get_zone)
    yield


app = FastAPI(title="Fountain Control Daemon", lifespan=lifespan)

# The daemon only ever listens on 127.0.0.1 (see config.py), but that stops
# the network, not a browser tab: any website open on this machine can also
# reach 127.0.0.1:8765, so a wildcard CORS origin would let ANY page's JS read
# /zones, /scenarios and arbitrary local files off /audio. Only two origins
# are ever a legitimate renderer: electron-vite's dev server
# (http://localhost:5173, a different origin than the daemon's own
# 127.0.0.1:8765 as far as fetch() is concerned) and "null" -- what a packaged
# Electron build's file:// page sends as Origin. See config.ALLOWED_ORIGINS
# (also used to reject the WS handshake itself below, since WebSocket isn't
# subject to CORS at all).
#
# allow_methods must cover every verb the REST surface actually uses, not
# just GET -- POST /scenarios/{id} (timeline Save) and DELETE /scenarios/{id}
# (timeline Delete) are non-simple cross-origin requests (JSON body), so the
# browser sends a preflight OPTIONS first and blocks the real request if the
# method isn't in this list. Restricting this to "GET" silently broke saving
# and deleting scenarios from the HMI while every read-only screen kept
# working, which is why it went unnoticed.
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "zones_active": list(zones.keys())}


@app.get("/zones")
async def get_zones() -> list[dict]:
    """Read-only snapshot of every zone's current configuration -- what
    driver instances exist and what devices are mapped onto them. The HMI
    fetches this on connect/reconnect to rehydrate its device-config screen
    from the daemon (the source of truth) instead of only knowing about
    whatever it itself has sent commands for this session."""
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
            # Round-tripped so the HMI's live-control sliders can show
            # what the daemon actually has right now on load/reconnect,
            # rather than always assuming 100% -- these are runtime-only
            # (never persisted), so this GET is the only way to learn the
            # current value after a page reload or a second client connecting.
            "global_brightness": round(zone.global_brightness * 100),
            "global_speed": round(zone.global_speed * 100),
        })
    return result


@app.get("/drivers")
async def get_drivers() -> list[dict]:
    """Read-only lookup, same rationale as /health -- a stateless list the
    HMI's device-config form renders from, not something that belongs on the
    WS command channel. `config_schema` is the driver's Pydantic config model
    as JSON Schema, so the frontend can build the config form dynamically
    instead of hardcoding fields per driver type."""
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
    return persistence.list_scenarios()


@app.get("/scenarios/{scenario_id}")
async def get_scenario(scenario_id: str) -> dict:
    """Full content for the timeline UI to edit -- GET reads exactly what
    POST (below) writes."""
    try:
        return persistence.read_scenario_raw(scenario_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/audio")
async def get_audio(path: str) -> FileResponse:
    """Serves a music_file's raw bytes so the timeline UI can decode it
    client-side (Web Audio API) and draw a waveform -- see the daemon-plays
    vs. browser-draws split from the audio architecture discussion. This is
    not a new capability the daemon didn't already have: it already reads
    and plays this exact file (app/audio.py); this just lets the browser
    read the same bytes. Same path resolution as playback (resolve_music_path),
    so a relative path here means the same file it would when actually played.
    """
    try:
        resolved = persistence.resolve_music_path(path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not resolved.is_file():
        raise HTTPException(status_code=404, detail=f"audio file not found: {path}")
    return FileResponse(resolved)


@app.post("/scenarios/{scenario_id}")
async def put_scenario(scenario_id: str, payload: persistence.ScenarioFileDto) -> dict:
    """The timeline UI's save action. Plain file write, not a WS command --
    same reasoning as GET /scenarios: this is CRUD on a file, not a runtime
    hardware mutation, so it belongs on the REST side."""
    try:
        await persistence.save_scenario(scenario_id, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": "ok", "scenario_id": scenario_id}


@app.delete("/scenarios/{scenario_id}")
async def delete_scenario(scenario_id: str) -> dict:
    """The timeline UI's delete action -- there was previously no way to
    remove an old/test scenario file short of editing data/scenarios/ by
    hand. A currently-playing scenario is unaffected: PLAY_SCENARIO reads
    the file once at play-start into an in-memory Project (load_scenario),
    it doesn't keep re-reading the file, so deleting it mid-playback can't
    interrupt a running show."""
    try:
        persistence.delete_scenario(scenario_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"status": "ok", "scenario_id": scenario_id}


@app.websocket(config.WS_PATH)
async def ws_endpoint(websocket: WebSocket) -> None:
    # CORS (above) doesn't apply to WebSocket at all, so without this check
    # any website open in a browser on this machine could connect straight to
    # the hardware-control channel with nothing but
    # `new WebSocket("ws://127.0.0.1:8765/ws")` and send EMERGENCY_STOP,
    # PLAY_SCENARIO, SET_DEVICE_STATE, etc. A real browser always sends
    # Origin on a cross-origin WS handshake, so reject anything that sends
    # one we don't recognize; a missing Origin (a non-browser tool -- direct
    # test scripts, wscat) is let through, since blocking that would need
    # real auth, which is a separate, bigger change than closing this hole.
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
        # asyncio.wait() never raises a task's exception -- it just returns
        # once one finishes, successfully or not -- so the `except
        # WebSocketDisconnect` this used to have here was dead code: a
        # normal disconnect finishes reader() by raising inside that task,
        # not out of this await. Pulling each done task's result surfaces
        # WebSocketDisconnect (routine, not logged) vs. an actual bug in
        # reader/writer/heartbeat (logged -- previously silent apart from
        # asyncio's own "exception was never retrieved" stderr line).
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

    await _send_ack(websocket, ack)


async def _send_ack(websocket: WebSocket, ack: Ack) -> None:
    """A slow command (EMERGENCY_STOP retrying unresponsive hardware can take
    several hundred ms) can outlive the client's connection -- this used to
    send the ok=True Ack unconditionally, and on failure (client already
    gone) fall into the except block above, which tried to send a SECOND
    Ack that failed the exact same way, except uncaught: it silently killed
    the reader task and, with it, this connection's writer/heartbeat too.
    The command itself already ran either way; there's just no one left to
    tell, which isn't this connection's problem anymore."""
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
            # Registers regardless of whether this connect attempt succeeds
            # (see zone_runtime.py) -- connect failure surfaces as a
            # HardwareErrorEvent on the bus, not as a failed Ack, since
            # configuring hardware before it's reachable is normal setup,
            # not a command error. An unknown driver_type still raises
            # (KeyError from the registry), which IS a real config mistake.
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
            project = persistence.load_scenario(cmd.scenario_id)  # raises FileNotFoundError -> Ack(ok=False)
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
            zone = get_zone(cmd.zone_id)
            await zone.reconnect_instance(cmd.instance_id)

        case "SET_DEVICE_STATE":
            zone = get_zone(cmd.zone_id)
            zone.set_device_state(cmd.device_id, cmd.parameters)

        case "RESET_MOTOR_FAULT":
            zone = get_zone(cmd.zone_id)
            if not await zone.reset_motor_fault(cmd.device_id):
                raise RuntimeError(f"fault reset failed for '{cmd.device_id}'")


def run() -> None:
    uvicorn.run(app, host=config.HOST, port=config.PORT, log_level="info")


if __name__ == "__main__":
    run()
