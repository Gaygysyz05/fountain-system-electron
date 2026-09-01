"""
Minimal stand-in for zone/fountain_zone_models.py, now shaped for the
universal driver-based device model (see app/drivers/base.py).

Deliberately DROPS EventType and the old zone_id/fountain_id fields that
existed on Event. Under the driver-registry model, a device's category
(valve/motor/light) and its addressing (which driver instance, which
channel) are properties of the DEVICE, registered once via ADD_DEVICE --
not something every single scenario event needs to repeat. The scheduler
below only ever needs `device_id` to route a state; ZoneRuntime resolves
that id to (driver instance, channel) via its own device map. This also
kills a class of bug from the original: an event's declared type could
never disagree with what the device actually is, because there's only one
source of truth now.

`parameters` is category-shaped by convention, matching what each driver's
`apply_state()` expects: {"on": bool} for a valve, {"frequency", "active"}
for a motor, {"r", "g", "b"} for a light. The daemon doesn't validate this
shape against the device's actual category yet -- that belongs in the
project/scenario file loader, not the runtime hot path.

The real port from fountain_zone_models.py still just needs the one QColor
import removed (see the previous revision's note) plus this device_id-only
addressing applied to its own Event class.
"""
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
    """Path to a background audio track (mp3/wav/ogg), played back by
    app/audio.py in lockstep with this project's playback -- see the
    daemon-side-playback vs. browser-side-waveform split in that module's
    docstring. None means a silent show."""
