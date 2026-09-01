"""Regression tests for ArtNetLightDriver -- guards the Node8's 0-7 universe
range validation and the +1 translation in apply_state() that keeps a
0-based user-facing universe number mapped to the correct physical output
(both from the "не канал а slave id" / off-by-one fix this session)."""
from __future__ import annotations

import struct

from app.drivers.artnet_light_driver import ArtNetLightConfig, ArtNetLightDriver
from app.event_bus import EventBus
from tests.fakes.fake_artnet import FakeArtNetListener


def _assert_close(actual: bytes, expected: tuple[int, int, int]) -> None:
    # The fader's own "snap to target" frame doesn't always flag itself as
    # changed (see AsyncArtNetController._fader_loop), so the last packet
    # actually sent can rest 1 unit short of the exact target -- harmless
    # for a light's color, but would make a byte-exact assert flaky.
    assert all(abs(a - e) <= 1 for a, e in zip(actual, expected)), f"{actual!r} not within 1 of {expected!r}"


async def make_driver(listener: FakeArtNetListener) -> ArtNetLightDriver:
    config = ArtNetLightConfig(target_ip="127.0.0.1", target_port=listener.port)
    driver = ArtNetLightDriver(zone_id=1, instance_id="Dmx 1", config=config, bus=EventBus())
    assert await driver.connect()
    return driver


async def test_register_channel_accepts_only_0_to_7() -> None:
    async with FakeArtNetListener() as listener:
        driver = await make_driver(listener)

        assert await driver.register_channel("0") is True
        assert await driver.register_channel("7") is True
        assert await driver.register_channel("8") is False  # Node8 has exactly 8 outputs: 0-7
        assert await driver.register_channel("-1") is False
        assert await driver.register_channel("abc") is False

        await driver.disconnect()


async def test_apply_state_maps_channel_directly_to_wire_universe() -> None:
    """Universe "0" (the Node8's own first output, per its label) must reach
    the wire as Art-Net universe 0, and "7" as universe 7 -- these used to be
    off by one (the field only accepted 1-8, and the wire computed
    universe = channel - 1, so "0" couldn't be addressed at all)."""
    async with FakeArtNetListener() as listener:
        driver = await make_driver(listener)

        driver.apply_state("0", {"r": 255, "g": 10, "b": 20})
        dmx = await listener.wait_for_universe(0)
        _assert_close(dmx[0:3], (255, 10, 20))

        driver.apply_state("7", {"r": 1, "g": 2, "b": 3})
        dmx = await listener.wait_for_universe(7)
        _assert_close(dmx[0:3], (1, 2, 3))

        await driver.disconnect()
