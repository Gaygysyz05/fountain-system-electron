"""Generic device-driven scheduler: batches events per device per tick and forwards all (changed or not) to ZoneRuntime, the only place that knows how to route a device_id and decide what's safe to dedup (see zone_runtime.py's _dispatch_device_state); watchdog tracking is likewise opt-in per device via `active_devices`/`watchdog_timeout`, not tied to device type."""
from __future__ import annotations

import asyncio
import contextlib
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

        # device_id -> last-refreshed time; mutate only via mark_device_active/inactive, never directly (see _watchdog_task).
        self.active_devices: dict[str, float] = {}
        self.watchdog_timeout = DEFAULT_WATCHDOG_TIMEOUT

        self._seeking = False  # true while a seek's audio reposition is in flight -- see seek()/_loop()
        self._task: Optional[asyncio.Task] = None
        # Runs _check_watchdog on a fixed cadence independent of playback state; stays None until a device opts in, so watchdog-free zones never spin an idle poll loop.
        self._watchdog_task: Optional[asyncio.Task] = None

        self.audio = AudioPlayer()
        self._loaded_music_file: Optional[str] = None

        # Injected by ZoneRuntime; routing by device_id is ZoneRuntime's job, not the scheduler's.
        self.on_device_event: Optional[Callable[[Event], None]] = None

    # -- project / transport control ---------------------------------------

    def load_project(self, project: Project, scenario_id: Optional[str] = None) -> None:
        """PLAY_SCENARIO calls this on every press; resets to 0 only when loading a different scenario, so a SEEK_ZONE set while stopped survives replaying the same one."""
        same_scenario = scenario_id is not None and scenario_id == self.loaded_scenario_id
        self.project = project
        self.loaded_scenario_id = scenario_id
        self.pending_events = sorted(project.events, key=lambda e: e.time)
        if same_scenario:
            self.current_position = max(0.0, min(self.current_position, project.duration))
            self._sync_processed_events()
        else:
            self.reset()
            self.is_paused = False  # a pause from the OLD scenario must not survive into this one (see play()'s is_paused branch)

    def reset(self) -> None:
        self.current_position = 0.0
        self.processed_events.clear()
        self.last_processed_event_index = -1

    def _sync_processed_events(self) -> None:
        """Marks pending_events strictly before current_position as already-processed; must use `<`, not `<=`, or an event exactly at current_position (e.g. a fresh t=0 cue) would be marked processed before ever being dispatched."""
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
            # NOT reset() -- that would zero current_position and discard a SEEK_ZONE set while stopped; only resync bookkeeping to current position.
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
        self._force_stop_active_devices()
        if self._task:
            self._task.cancel()
            self._task = None
        if self._loaded_music_file:
            await self.audio.stop()
            self._loaded_music_file = None
        self.reset()
        self._publish_status("stopped")

    def _force_stop_active_devices(self) -> None:
        """STOP_ZONE must actually stop tracked hardware (e.g. a still-spinning motor), not just clear the watchdog set -- sends the same forced-off event the watchdog itself sends on timeout to every tracked device before forgetting it."""
        for device_id in list(self.active_devices):
            if self.on_device_event:
                try:
                    self.on_device_event(Event(time=self.current_position, device_id=device_id, parameters={"active": False, "on": False}))
                except Exception:  # noqa: BLE001 -- one bad device must not stop the rest from being force-stopped
                    logger.exception("zone %s: force-stop on stop() failed for device %s", self.zone_id, device_id)
        self.active_devices.clear()

    def mark_device_active(self, device_id: str) -> None:
        """Registers/refreshes device_id in the watchdog set and lazily starts the standalone watchdog task, so a zone that never opts in never spins an idle poll loop; always use this instead of writing `active_devices` directly."""
        self.active_devices[device_id] = time.monotonic()
        if self._watchdog_task is None or self._watchdog_task.done():
            self._watchdog_task = asyncio.create_task(self._watchdog_loop())

    def mark_device_inactive(self, device_id: str) -> None:
        self.active_devices.pop(device_id, None)

    async def aclose(self) -> None:
        """Must be called when this player's zone is being torn down for good (see ZoneRuntime.disconnect()), or the watchdog task outlives it, holding a reference to `self` and polling a dict nothing can mutate anymore."""
        if self._watchdog_task:
            self._watchdog_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._watchdog_task
            self._watchdog_task = None

    async def seek(self, position: float) -> None:
        if not self.project:
            return
        self.current_position = max(0.0, min(position, self.project.duration))
        self._sync_processed_events()
        if self._loaded_music_file:
            # _loop() freezes current_position while _seeking is true so the tick clock can't outrun audio.seek()'s latency (SDL set_pos() isn't instant).
            self._seeking = True
            try:
                await self.audio.seek(self.current_position)
            finally:
                self._seeking = False
                self._last_tick_time = time.monotonic()
        # The tick loop only publishes status while ticking, so a seek while paused/stopped must publish here or no UI learns it happened until playback resumes.
        self._publish_status("paused" if self.is_paused else ("playing" if self.is_playing else "stopped"))

    # -- the tick loop -------------------------------------------------------

    async def _loop(self) -> None:
        try:
            while True:
                loop_start = time.monotonic()

                if not self.is_playing or self.is_paused or self._seeking:
                    await asyncio.sleep(0.1)
                    continue

                now = time.monotonic()
                delta = min(now - self._last_tick_time, 0.25)  # clamp stalls (debugger pause, etc.)
                self._last_tick_time = now
                self.current_position += delta

                if self.current_position >= self.project.duration:
                    if self.is_looping:
                        self.reset()
                        # reset() only rewinds the EVENT clock; audio.play() is play-once, so it must be restarted here too, exactly on the scenario's wrap tick, or audio and hardware drift apart.
                        if self._loaded_music_file:
                            try:
                                await self.audio.play()
                                # Re-check is_playing after the await: a Stop landing mid-restart already flipped it synchronously (see stop()), and AudioPlayer's lock only prevents concurrent SDL calls, not which one should win -- without this recheck, Stop wouldn't stick.
                                if not self.is_playing:
                                    await self.audio.stop()
                            except Exception:  # noqa: BLE001 -- see the tick-processing try/except below: this task is fire-and-forget and nothing supervises it, so ANY exception here (not just the pygame.error AudioPlayer.play() already catches) must not be allowed to kill the loop -- a dead loop stops the watchdog too, leaving an active device with nothing to force-stop it.
                                logger.exception("zone %s: failed to restart music on loop wrap, continuing without it", self.zone_id)
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

    async def _watchdog_loop(self) -> None:
        """Runs independently of the tick loop so a device left active with nothing playing (a manual test-fire, or a show that ended) still gets checked; skipped only during an intentional pause, which isn't the stalled-stream case the watchdog exists to catch."""
        try:
            while True:
                await asyncio.sleep(0.5)
                if self.is_paused:
                    continue
                try:
                    self._check_watchdog(time.monotonic())
                except Exception:  # noqa: BLE001
                    logger.exception("zone %s: standalone watchdog check failed, continuing", self.zone_id)
        except asyncio.CancelledError:
            raise

    def _check_watchdog(self, now: float) -> None:
        """Force-stops any device (opted in via ZoneRuntime._handle_device_event) not refreshed within `watchdog_timeout`, e.g. a VFD whose event stream stalled."""
        timed_out = [device_id for device_id, last in self.active_devices.items() if now - last > self.watchdog_timeout]
        for device_id in timed_out:
            logger.warning("zone %s: device %s watchdog timeout, forcing stop", self.zone_id, device_id)
            del self.active_devices[device_id]
            if self.on_device_event:
                # One device's driver raising here must not stop the rest of this pass's timed-out devices from being force-stopped.
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
            # Forwarded even if identical to last tick's value -- only ZoneRuntime knows what's safe to dedup (see _dispatch_device_state).
            try:
                self.on_device_event(event)
            except Exception:  # noqa: BLE001 -- one bad device (e.g. an unparseable channel) must not block the rest of this tick's batch
                logger.exception("zone %s: on_device_event failed for device %s", self.zone_id, device_id)

    def _publish_status(self, state: str) -> None:
        self.bus.publish(ZoneStatusEvent(
            zone_id=self.zone_id,
            state=state,  # type: ignore[arg-type]
            # Reports loaded_scenario_id (not play()'s fleeting argument) so a reconnecting HMI can learn which scenario is actually running.
            scenario_id=self.loaded_scenario_id,
            position=round(self.current_position, 2),
            duration=self.project.duration if self.project else 0.0,
            is_looping=self.is_looping,
        ))
