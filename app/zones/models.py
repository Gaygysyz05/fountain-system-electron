"""device_id-only addressing (no per-event type/zone fields) because category and routing live once on the registered device (see app/drivers/base.py), eliminating a class of type-mismatch bug; `parameters` shape matches each driver's apply_state() but is intentionally unvalidated here (that belongs in the project/scenario loader)."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Event:
    time: float
    device_id: str
    parameters: dict = field(default_factory=dict)


@dataclass
class Project:
    duration: float
    events: list[Event] = field(default_factory=list)
    music_file: str | None = None
    """Background track (mp3/wav/ogg) played by app/audio.py in lockstep with this project; see that module's docstring for the daemon-playback vs. browser-waveform split. None means a silent show."""
