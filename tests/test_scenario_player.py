"""Unit tests for ZoneScenarioPlayer's load/seek/play position bookkeeping --
previously zero coverage, and exactly the kind of subtle off-by-one bug the
class's own docstrings warn about (see load_project/seek)."""
from __future__ import annotations

import asyncio

from app.event_bus import EventBus
from app.zones.models import Event, Project
from app.zones.scenario_player import ZoneScenarioPlayer
from tests.fakes.fake_audio import FakeAudioPlayer


def _make_player() -> tuple[ZoneScenarioPlayer, list[Event]]:
    bus = EventBus()
    player = ZoneScenarioPlayer(zone_id=1, bus=bus, tick_interval=0.02)
    received: list[Event] = []
    player.on_device_event = received.append
    return player, received


async def test_seek_while_stopped_is_not_discarded_by_play() -> None:
    """A SEEK_ZONE sent while stopped used to get silently wiped the moment
    Play was pressed, because play() called reset() unconditionally."""
    player, received = _make_player()
    project = Project(duration=10.0, events=[
        Event(time=1.0, device_id="D1", parameters={"on": True}),
        Event(time=5.0, device_id="D1", parameters={"on": False}),
    ])
    player.load_project(project, "s1")
    await player.seek(4.0)

    await player.play()
    await asyncio.sleep(0.05)
    await player.stop()

    # The t=1.0 event is BEFORE the seek target -- must not fire.
    assert not any(e.time == 1.0 for e in received)


async def test_reloading_the_same_scenario_keeps_position() -> None:
    """load_project() is called on every PLAY_SCENARIO press, not just the
    first -- reloading the SAME scenario (e.g. an edit was saved since the
    last play) must not reset playback back to 0."""
    player, _ = _make_player()
    project = Project(duration=10.0, events=[])
    player.load_project(project, "s1")
    await player.seek(3.0)

    player.load_project(project, "s1")  # same scenario_id again

    assert player.current_position == 3.0


async def test_loading_a_different_scenario_resets_to_zero() -> None:
    """Switching to a genuinely different scenario IS a fresh show and
    should start at the top, unlike the same-scenario case above."""
    player, _ = _make_player()
    project_a = Project(duration=10.0, events=[])
    player.load_project(project_a, "s1")
    await player.seek(3.0)

    project_b = Project(duration=20.0, events=[])
    player.load_project(project_b, "s2")

    assert player.current_position == 0.0


async def test_loop_wraps_position_and_replays_events() -> None:
    """is_looping must actually replay events after wrapping back to 0, not
    just reset the clock -- reset() clears the dedup cache that would
    otherwise suppress the identical event on the next lap."""
    player, received = _make_player()
    project = Project(duration=0.1, events=[
        Event(time=0.0, device_id="D1", parameters={"on": True}),
    ])
    player.load_project(project, "s1")
    player.is_looping = True
    await player.play()
    await asyncio.sleep(0.35)  # several loop cycles at tick_interval=0.02/duration=0.1
    await player.stop()

    assert len(received) >= 2  # the t=0 event fired again after each wrap


async def test_loop_restarts_the_music_track_on_each_wrap() -> None:
    """AudioPlayer.play() is a play-ONCE call (see audio.py) -- looping the
    valve/motor schedule via reset() alone left the track to play through
    to its natural end and go silent while the show kept looping around
    it. Each wrap must call play() again to restart the track alongside
    the hardware schedule, on the scenario player's own tick clock."""
    player, _ = _make_player()
    fake_audio = FakeAudioPlayer()
    player.audio = fake_audio  # type: ignore[assignment]
    project = Project(duration=0.1, events=[], music_file="show.mp3")
    player.load_project(project, "s1")
    player.is_looping = True

    await player.play()
    assert fake_audio.play_count == 1  # the initial play, from play() itself

    await asyncio.sleep(0.35)  # several loop cycles at tick_interval=0.02/duration=0.1
    await player.stop()

    assert fake_audio.play_count >= 3  # initial play + at least 2 wraps


async def test_stop_during_loop_wrap_restart_leaves_audio_stopped() -> None:
    """A Stop landing while _loop() is mid-`await self.audio.play()` for a
    loop-wrap restart used to have no effect on the audio -- stop()'s own
    audio.stop() could complete first (or the two could race at the SDL
    level), then the in-flight play() would finish and leave the track
    audibly playing again right after the operator pressed Stop. _loop()
    must notice is_playing went False while it was suspended and re-stop."""
    player, _ = _make_player()
    fake_audio = FakeAudioPlayer()

    # Simulates the exact race: by the time AudioPlayer.play()'s (awaited)
    # executor job would resolve, a concurrent stop() has already flipped
    # is_playing (which stop() does synchronously, before its own first
    # await -- see scenario_player.py's stop()).
    real_play = fake_audio.play

    async def play_and_race_a_concurrent_stop() -> None:
        player.is_playing = False
        await real_play()

    fake_audio.play = play_and_race_a_concurrent_stop  # type: ignore[method-assign]
    player.audio = fake_audio  # type: ignore[assignment]

    project = Project(duration=0.05, events=[], music_file="show.mp3")
    player.load_project(project, "s1")
    player.is_looping = True

    await player.play()
    await asyncio.sleep(0.15)  # let at least one loop-wrap fire

    assert fake_audio.play_count >= 1  # the racing restart really was attempted
    assert fake_audio.stopped is True  # ...but the race was caught and corrected


async def test_non_looping_playback_stops_at_duration() -> None:
    player, _ = _make_player()
    project = Project(duration=0.05, events=[])
    player.load_project(project, "s1")
    await player.play()

    await asyncio.sleep(0.2)

    assert player.is_playing is False
    assert player.current_position == project.duration
