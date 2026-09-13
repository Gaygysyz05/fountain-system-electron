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


async def test_switching_to_a_different_scenario_while_paused_loads_its_own_audio() -> None:
    """pause() sets is_paused=True but never touches _loaded_music_file;
    load_project() for a genuinely different scenario used to leave
    is_paused untouched too. Pressing Play after switching scenarios
    while paused would then just resume() the OLD track instead of
    loading the new scenario's music, even though the hardware schedule
    had already been reset to the new scenario's events from 0."""
    player, _ = _make_player()
    fake_audio = FakeAudioPlayer()
    player.audio = fake_audio  # type: ignore[assignment]

    project_a = Project(duration=10.0, events=[], music_file="a.mp3")
    player.load_project(project_a, "A")
    await player.play()
    await player.pause()
    assert player.is_paused is True

    project_b = Project(duration=20.0, events=[], music_file="b.mp3")
    player.load_project(project_b, "B")  # different scenario while still paused

    assert player.is_paused is False  # must not carry the old pause into the new show

    await player.play()

    assert fake_audio.loaded_file == "b.mp3"  # loaded B's track, not resumed A's

    await player.stop()


async def test_seek_while_playing_does_not_let_the_clock_run_ahead_of_a_slow_audio_seek() -> None:
    """seek() writes current_position synchronously and only then awaits
    audio.seek() -- itself potentially slow (SDL set_pos()). Without
    freezing the tick clock for that window, _loop() keeps adding real
    elapsed time on top of the just-set position while the audio
    reposition is still in flight, permanently offsetting the hardware
    schedule from the actual track position by however long that took."""
    player, _ = _make_player()
    fake_audio = FakeAudioPlayer()
    real_seek = fake_audio.seek

    async def slow_seek(position: float) -> None:
        await asyncio.sleep(0.3)
        await real_seek(position)

    fake_audio.seek = slow_seek  # type: ignore[method-assign]
    player.audio = fake_audio  # type: ignore[assignment]

    project = Project(duration=10.0, events=[], music_file="show.mp3")
    player.load_project(project, "s1")
    await player.play()

    await player.seek(4.9)

    assert player.current_position == 4.9  # not advanced by the 0.3s the reposition itself took

    await player.stop()


async def test_watchdog_fires_independent_of_playback_state() -> None:
    """The tick loop's own _check_watchdog call only runs while _loop is
    actually ticking through its "playing" branch. A device marked active
    while nothing is playing at all -- a manual Devices-tab test-fire, or
    one still active after a non-looping show reaches its natural end and
    _loop returns for good -- used to have nothing ever checking it again
    once the loop stopped. The standalone watchdog task must catch this."""
    player, received = _make_player()
    player.watchdog_timeout = 0.05

    player.mark_device_active("D1")
    await asyncio.sleep(0.8)  # the watchdog loop polls every 0.5s -- give it a full cycle past the timeout

    force_stops = [e for e in received if e.device_id == "D1" and e.parameters == {"active": False, "on": False}]
    assert force_stops, "a device marked active while idle was never watchdog-checked"
    assert "D1" not in player.active_devices

    await player.aclose()


async def test_stop_force_stops_tracked_devices_instead_of_forgetting_them() -> None:
    """stop() used to just active_devices.clear() -- that silences the
    watchdog but does nothing to the device itself, so a motor already
    spinning at its last commanded frequency kept spinning right after the
    operator pressed Stop, with its only safety net now gone too."""
    player, received = _make_player()
    player.mark_device_active("D1")

    await player.stop()

    force_stops = [e for e in received if e.device_id == "D1" and e.parameters == {"active": False, "on": False}]
    assert force_stops, "stop() did not force-stop a device it was tracking"
    assert player.active_devices == {}

    await player.aclose()
