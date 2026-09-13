"""Runs in-process (not over a network) so playback shares ZoneScenarioPlayer's tick clock with the hardware; all pygame.mixer/SDL calls are synchronous, so every method here uses run_in_executor to avoid stalling the 50ms relay/VFD tick loop."""
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
        # Serializes calls into SDL_mixer (not documented thread-safe) across the shared executor pool; doesn't decide play/stop precedence -- that's ZoneScenarioPlayer's job.
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
                # A hiccup here must not crash the tick loop (see scenario_player.py's loop-wrap restart, which calls this every lap).
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
                # Not every format supports seeking via SDL_mixer (MP3 varies by build); log and move on rather than crash on a scrub attempt.
                logger.warning("seek to %.2fs not supported for this file: %s", position, exc)

        async with self._lock:
            await asyncio.get_event_loop().run_in_executor(None, _seek)

    def is_playing(self) -> bool:
        return _mixer_ready and pygame.mixer.music.get_busy()
