"""Duck-typed stand-in for app.audio.AudioPlayer -- pygame.mixer needs a real
(or at least SDL-dummy-configured) audio device to initialize, which a CI
box may not have, and the whole point here is asserting on WHEN
ZoneScenarioPlayer calls play()/seek()/stop(), not on actual sound output."""
from __future__ import annotations


class FakeAudioPlayer:
    def __init__(self) -> None:
        self.loaded_file: str | None = None
        self.play_count = 0
        self.seek_positions: list[float] = []
        self.stopped = False
        self.paused = False

    async def load(self, file_path: str) -> bool:
        self.loaded_file = file_path
        return True

    async def play(self) -> None:
        self.play_count += 1
        self.stopped = False
        self.paused = False

    async def pause(self) -> None:
        self.paused = True

    async def resume(self) -> None:
        self.paused = False

    async def stop(self) -> None:
        self.stopped = True

    async def seek(self, position: float) -> None:
        self.seek_positions.append(position)

    def is_playing(self) -> bool:
        return self.loaded_file is not None and not self.stopped and not self.paused
