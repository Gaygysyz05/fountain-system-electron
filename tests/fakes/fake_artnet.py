"""A real UDP socket capturing Art-Net DMX packets exactly as the physical
Node8 would receive them -- lets tests assert on the actual wire universe
number and DMX bytes AsyncArtNetController sends, instead of mocking the
socket call away."""
from __future__ import annotations

import asyncio
import struct

ART_NET_ID = b"Art-Net\x00"


class FakeArtNetListener(asyncio.DatagramProtocol):
    def __init__(self) -> None:
        self.captured: list[tuple[int, bytes]] = []  # (universe, dmx_data)
        self.transport: asyncio.DatagramTransport | None = None
        self.port = 0

    def connection_made(self, transport: asyncio.BaseTransport) -> None:
        self.transport = transport  # type: ignore[assignment]

    def datagram_received(self, data: bytes, addr: tuple[str, int]) -> None:
        if not data.startswith(ART_NET_ID):
            return
        universe = struct.unpack_from("<H", data, 14)[0]
        dmx_data = data[18:]
        self.captured.append((universe, dmx_data))

    async def start(self) -> "FakeArtNetListener":
        loop = asyncio.get_running_loop()
        transport, _ = await loop.create_datagram_endpoint(lambda: self, local_addr=("127.0.0.1", 0))
        self.transport = transport
        self.port = transport.get_extra_info("sockname")[1]
        return self

    def stop(self) -> None:
        if self.transport:
            self.transport.close()

    async def __aenter__(self) -> "FakeArtNetListener":
        return await self.start()

    async def __aexit__(self, *exc: object) -> None:
        self.stop()

    async def wait_for_universe(self, universe: int, settle: float = 1.5) -> bytes:
        """Waits out the real controller's fade (see artnet.py's
        SMOOTH_SPEED -- a target color is approached over several 60fps
        frames, not sent instantly) and returns the LATEST packet captured
        for `universe`, not the first -- an early frame is still mid-fade
        and would assert on the wrong color."""
        await asyncio.sleep(settle)
        for u, data in reversed(self.captured):
            if u == universe:
                return data
        raise AssertionError(f"no Art-Net packet seen for universe {universe} after {settle}s")
