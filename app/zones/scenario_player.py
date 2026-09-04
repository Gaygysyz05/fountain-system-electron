"""
Async rewrite of zone/zone_scenario_player.py (ZoneScenarioPlayer), now
generalized over the driver-based device model instead of four hardcoded
device types.

What changed from the previous revision (see git history / prior discussion
for the threading->asyncio port itself, which is unchanged): the four
type-specific callbacks (on_valve_batch, on_motor_event, on_lighting_event,
on_nozzle_event) collapse into ONE `on_device_event`, keyed purely by
`Event.device_id`. The scheduler has no idea what a "valve" or "motor" is
anymore -- it batches and dedupes events per device per tick exactly like
before, then hands each changed device's latest Event to ZoneRuntime, which
is the only place that knows how to route a device_id to a driver instance
and channel (see zone_runtime.py). This is what makes adding a new device
category later (say, a sensor input) not require touching this file.

The motor watchdog generalizes the same way: it used to be motor-specific
(active_motors: dict[slave_id, timestamp]); now any device category CAN opt
into "must be refreshed every N seconds or get force-stopped" by appearing
in `active_devices`, and ZoneRuntime decides which categories actually push
themselves into that set via `watchdog_timeout` in the applied state (motor
frequency commands do; valve on/off and light color, being level-triggered
rather than a continuously-driven analog output, do not need it).
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Callable, Optional

from app.audio import AudioPlayer
from app.event_bus import EventBus
from app.protocol import ZoneStatusEvent
from app.zones.models import Event, Project

logger = logging.getLogger("fountain.zones.scenario_player")

DEFAULT_WATCHDOG_TIMEOUT = 2.0


class ZoneScenarioPlayer:
    def __init__(self, zone_id: int, bus: EventBus, tick_interval: float = 0.05) -> None:
        self.zone_id = zone_id
        self.bus = bus
        self.tick_interval = tick_interval

        self.project: Optional[Project] = None
        self.loaded_scenario_id: Optional[str] = None
        self.pending_events: list[Event] = []
        self.processed_events: set[int] = set()
        self.last_processed_event_index = -1

        self.is_playing = False
        self.is_paused = False
        self.is_looping = False
        self.current_position = 0.0
        self._last_tick_time = 0.0

        # device_id -> last-refreshed monotonic time, for devices whose state
        # must be continuously re-affirmed (see ZoneRuntime's watchdog opt-in).
        self.active_devices: dict[str, float] = {}
        self.watchdog_timeout = DEFAULT_WATCHDOG_TIMEOUT

        self._last_device_states: dict[str, object] = {}
        self._task: Optional[asyncio.Task] = None

        self.audio = AudioPlayer()
        self._loaded_music_file: Optional[str] = None

        # Injected by ZoneRuntime at wiring time. One callback for every
        # device category -- routing by device_id is ZoneRuntime's job, not
        # the scheduler's.
        self.on_device_event: Optional[Callable[[Event], None]] = None

    # -- project / transport control ---------------------------------------

    def load_project(self, project: Project, scenario_id: Optional[str] = None) -> None:
        """PLAY_SCENARIO calls this on every press, not just the first --
        deliberately, so an edit saved since the last play is picked up
        instead of replaying stale in-memory events. That used to mean an
        unconditional reset() here too, discarding any SEEK_ZONE the
        operator had set up while stopped the moment they pressed Play.
        Now it only resets to 0 when this is actually a DIFFERENT scenario
        than what's currently loaded (a fresh show should start at the
        top); replaying the same one keeps wherever current_position
        already is -- 0 after a Stop, or a specific point after a seek."""
        same_scenario = scenario_id is not None and scenario_id == self.loaded_scenario_id
        self.project = project
        self.loaded_scenario_id = scenario_id
        self.pending_events = sorted(project.events, key=lambda e: e.time)
        if same_scenario:
            self.current_position = max(0.0, min(self.current_position, project.duration))
            self._sync_processed_events()
        else:
            self.reset()

    def reset(self) -> None:
        self.current_position = 0.0
        self.processed_events.clear()
        self.last_processed_event_index = -1
        self._last_device_states.clear()

    def _sync_processed_events(self) -> None:
        """Recomputes which pending_events are already 'in the past'
        relative to the CURRENT current_position, without touching
        current_position itself -- the bookkeeping seek() and a fresh
        play() both need, but reset() always forced back to 0 too, which
        is exactly why a SEEK_ZONE sent while stopped used to get silently
        wiped out the moment Play was pressed.

        Strictly `<`, not `<=`: an event exactly AT current_position hasn't
        actually fired yet, it's simply due right now -- _process_events
        (below) dispatches anything with `event.time <= current_position`
        on the very next tick using this same bookkeeping, so marking it
        "already processed" here means it never gets dispatched at all.
        With `<=` this silently ate every event scheduled at t=0 on a
        fresh play() (current_position is 0.0 at that point too, so a t=0
        cue -- a completely ordinary thing to author, e.g. "lights on at
        the start" -- looked exactly like something already in the past)
        and any event landing exactly on a seek target."""
        self.processed_events.clear()
        self.last_processed_event_index = -1
        for i, event in enumerate(self.pending_events):
            if event.time < self.current_position:
                self.processed_events.add(i)
                self.last_processed_event_index = i
            else:
                break

    async def play(self) -> None:
        if not self.project:
            return

        if not self.is_paused:
            # NOT reset() -- that would also zero current_position, discarding
            # a SEEK_ZONE sent while stopped (the operator setting where this
            # run should start from). Stop() already reset position to 0 on
            # its own; this only needs to resync the event-processed
            # bookkeeping to wherever current_position actually is right now.
            self._last_device_states.clear()
            self._sync_processed_events()
            if self.project.music_file and self.project.music_file != self._loaded_music_file:
                self._loaded_music_file = self.project.music_file if await self.audio.load(self.project.music_file) else None
            if self._loaded_music_file:
                await self.audio.seek(self.current_position)
                await self.audio.play()
        elif self._loaded_music_file:
            await self.audio.resume()

        self.is_playing = True
        self.is_paused = False
        self._last_tick_time = time.monotonic()
        if not self._task or self._task.done():
            self._task = asyncio.create_task(self._loop())

    async def pause(self) -> None:
        self.is_playing = False
        self.is_paused = True
        if self._loaded_music_file:
            await self.audio.pause()
        self._publish_status("paused")

    async def stop(self) -> None:
        self.is_playing = False
        self.is_paused = False
        self.active_devices.clear()
        if self._task:
            self._task.cancel()
            self._task = None
        if self._loaded_music_file:
            await self.audio.stop()
            self._loaded_music_file = None
        self.reset()
        self._publish_status("stopped")

    async def seek(self, position: float) -> None:
        if not self.project:
            return
        self.current_position = max(0.0, min(position, self.project.duration))
        self._sync_processed_events()
        if self._loaded_music_file:
            await self.audio.seek(self.current_position)
        # The tick loop is the only other thing that ever calls
        # _publish_status(), and only while actually ticking (is_playing) --
        # a seek while paused/stopped otherwise updates current_position with
        # nothing telling any connected UI it happened until playback resumes.
        self._publish_status("paused" if self.is_paused else ("playing" if self.is_playing else "stopped"))

    # -- the tick loop -------------------------------------------------------

    async def _loop(self) -> None:
        try:
            while True:
                loop_start = time.monotonic()

                if not self.is_playing or self.is_paused:
                    await asyncio.sleep(0.1)
                    continue

                now = time.monotonic()
                delta = min(now - self._last_tick_time, 0.25)  # clamp stalls (debugger pause, etc.)
                self._last_tick_time = now
                self.current_position += delta

                if self.current_position >= self.project.duration:
                    if self.is_looping:
                        self.reset()
                    else:
                        self.current_position = self.project.duration
                        self.is_playing = False
                        self._publish_status("stopped")
                        return

                try:
                    self._check_watchdog(now)
                    self._process_events()
                except Exception:  # noqa: BLE001 -- this task is fire-and-forget (asyncio.create_task in play(), never awaited), so an uncaught exception here would kill it silently: playback freezes mid-show with is_playing still True, AND the watchdog safety net (_check_watchdog, above) stops running with it, so an already-active motor would no longer get force-stopped either. Individual devices already isolate their own errors (see the try/excepts above); this is the backstop for anything else.
                    logger.exception("zone %s: error processing scenario tick, continuing", self.zone_id)
                self._publish_status("playing")

                elapsed = time.monotonic() - loop_start
                await asyncio.sleep(max(0.0, self.tick_interval - elapsed))
        except asyncio.CancelledError:
            raise

    def _check_watchdog(self, now: float) -> None:
        """Safety net: a device that opted into watchdog tracking (see
        ZoneRuntime._handle_device_event) and hasn't been refreshed in
        `watchdog_timeout` gets force-stopped -- e.g. a VFD whose event
        stream stalled keeps spinning otherwise."""
        timed_out = [device_id for device_id, last in self.active_devices.items() if now - last > self.watchdog_timeout]
        for device_id in timed_out:
            logger.warning("zone %s: device %s watchdog timeout, forcing stop", self.zone_id, device_id)
            del self.active_devices[device_id]
            if self.on_device_event:
                # One device's driver raising here (e.g. an unparseable
                # channel reaching int() deep in a driver's apply_state)
                # must not stop this loop from force-stopping the REST of
                # the timed-out devices in this same pass -- see _loop's
                # docstring-level comment on why the tick loop as a whole is
                # also wrapped.
                try:
                    self.on_device_event(Event(time=self.current_position, device_id=device_id, parameters={"active": False, "on": False}))
                except Exception:  # noqa: BLE001
                    logger.exception("zone %s: watchdog force-stop failed for device %s", self.zone_id, device_id)

    def _process_events(self) -> None:
        if self.last_processed_event_index >= len(self.pending_events) - 1:
            return

        device_batch: dict[str, Event] = {}  # last event per device wins this tick

        start = self.last_processed_event_index + 1
        for i in range(start, len(self.pending_events)):
            event = self.pending_events[i]
            if event.time > self.current_position:
                break

            self.processed_events.add(i)
            self.last_processed_event_index = i
            device_batch[event.device_id] = event

        if not device_batch or not self.on_device_event:
            return

        for device_id, event in device_batch.items():
            if self._last_device_states.get(device_id) == event.parameters:
                continue
            self._last_device_states[device_id] = event.parameters
            try:
                self.on_device_event(event)
            except Exception:  # noqa: BLE001 -- one bad device (e.g. an unparseable channel) must not block the rest of this tick's batch
                logger.exception("zone %s: on_device_event failed for device %s", self.zone_id, device_id)

    def _publish_status(self, state: str) -> None:
        self.bus.publish(ZoneStatusEvent(
            zone_id=self.zone_id,
            state=state,  # type: ignore[arg-type]
            # Was hardcoded None -- a HMI that (re)connects while this zone
            # is mid-show had no way to learn which scenario is actually
            # running, only that *something* is (state="playing"). Reports
            # loaded_scenario_id, not the play() call's fleeting argument --
            # this is the same field load_project() uses to decide whether a
            # replay is "the same scenario" (see its docstring), so it's
            # already exactly "whatever is currently loaded", stopped or not.
            scenario_id=self.loaded_scenario_id,
            position=round(self.current_position, 2),
            duration=self.project.duration if self.project else 0.0,
            is_looping=self.is_looping,
        ))
