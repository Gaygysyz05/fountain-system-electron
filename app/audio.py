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

    async def load(self, file_path: str) -> bool:
        def _load() -> bool:
            _ensure_mixer()
            try:
                pygame.mixer.music.load(file_path)
                return True
            except pygame.error as exc:
                logger.warning("failed to load audio file %s: %s", file_path, exc)
                return False

        ok = await asyncio.get_event_loop().run_in_executor(None, _load)
        self._loaded_file = file_path if ok else None
        return ok

    async def play(self) -> None:
        if not self._loaded_file:
            return
        await asyncio.get_event_loop().run_in_executor(None, pygame.mixer.music.play)

    async def pause(self) -> None:
        await asyncio.get_event_loop().run_in_executor(None, pygame.mixer.music.pause)

    async def resume(self) -> None:
        await asyncio.get_event_loop().run_in_executor(None, pygame.mixer.music.unpause)

    async def stop(self) -> None:
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

        await asyncio.get_event_loop().run_in_executor(None, _seek)

    def is_playing(self) -> bool:
        return _mixer_ready and pygame.mixer.music.get_busy()
