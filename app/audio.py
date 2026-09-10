"""
Background music playback for a zone's show -- runs on the same machine that
drives the hardware, because audio and light/water timing share one clock
(ZoneScenarioPlayer's tick loop). A playback host on a different machine over
a network could never guarantee that sync.

This is a DIFFERENT concern from the future timeline editor's waveform
display: that decodes and renders audio entirely in the browser via the Web
Audio API, no daemon involved -- authoring a scenario doesn't need this
module at all, only playing one back does.

Replaces the original's PyQt6 QMediaPlayer (managers/audio.py) with
pygame.mixer.music: no GUI dependency, ships its own SDL2 audio backend via
pip (nothing extra to install on the target machine, unlike e.g. python-vlc
which needs VLC present). All SDL calls are synchronous, so every method
here runs them via run_in_executor -- a slow codec load or seek must not
stall the same event loop that's driving relays/VFDs on a 50ms tick.
"""
from __future__ import annotations

import asyncio
import logging

import pygame

logger = logging.getLogger("fountain.audio")

_mixer_ready = False


def _ensure_mixer() -> None:
    global _mixer_ready
    if not _mixer_ready:
        pygame.mixer.init()
        _mixer_ready = True


class AudioPlayer:
    def __init__(self) -> None:
        self._loaded_file: str | None = None
        # SDL_mixer's own calls aren't documented as safe to call
        # concurrently from two threads -- every method here dispatches to
        # the SAME shared executor thread pool (run_in_executor(None, ...)),
        # so without serializing them, e.g. a loop-triggered play() and an
        # operator-triggered stop() issued around the same moment could
        # both be mid-call on pygame.mixer.music at once. The lock doesn't
        # decide which one "wins" (that's ZoneScenarioPlayer's job -- see
        # its loop-wrap restart re-checking is_playing after this awaits),
        # it just guarantees they never actually overlap at the SDL level.
        self._lock = asyncio.Lock()

    async def load(self, file_path: str) -> bool:
        def _load() -> bool:
            _ensure_mixer()
            try:
                pygame.mixer.music.load(file_path)
                return True
            except pygame.error as exc:
                logger.warning("failed to load audio file %s: %s", file_path, exc)
                return False

        async with self._lock:
            ok = await asyncio.get_event_loop().run_in_executor(None, _load)
        self._loaded_file = file_path if ok else None
        return ok

    async def play(self) -> None:
        if not self._loaded_file:
            return

        def _play() -> None:
            try:
                pygame.mixer.music.play()
            except pygame.error as exc:
                # Matches load()/seek()'s stance: a device hiccup here must
                # not take the whole scenario tick loop down with it (see
                # scenario_player.py's loop-wrap restart, the one caller
                # that runs on every lap of a looping show, not just once
                # at playback start).
                logger.warning("failed to (re)start music playback: %s", exc)

        async with self._lock:
            await asyncio.get_event_loop().run_in_executor(None, _play)

    async def pause(self) -> None:
        async with self._lock:
            await asyncio.get_event_loop().run_in_executor(None, pygame.mixer.music.pause)

    async def resume(self) -> None:
        async with self._lock:
            await asyncio.get_event_loop().run_in_executor(None, pygame.mixer.music.unpause)

    async def stop(self) -> None:
        async with self._lock:
            await asyncio.get_event_loop().run_in_executor(None, pygame.mixer.music.stop)

    async def seek(self, position: float) -> None:
        if not self._loaded_file:
            return

        def _seek() -> None:
            try:
                pygame.mixer.music.set_pos(position)
            except pygame.error as exc:
                # Not every format supports seeking via SDL_mixer (MP3 seek
                # support in particular varies by build) -- log and move on
                # rather than let a scrub attempt take the daemon down.
                logger.warning("seek to %.2fs not supported for this file: %s", position, exc)

        async with self._lock:
            await asyncio.get_event_loop().run_in_executor(None, _seek)

    def is_playing(self) -> bool:
        return _mixer_ready and pygame.mixer.music.get_busy()
