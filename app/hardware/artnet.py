"""Async rewrite of the old threading-based Art-Net controller; UDP sendto() is non-blocking, so the fader loop runs as a plain asyncio.Task with no executor needed."""
from __future__ import annotations

import asyncio
import logging
import socket
import struct

from app.event_bus import EventBus
from app.protocol import DeviceStateEvent, HardwareErrorEvent

logger = logging.getLogger("fountain.hardware.artnet")

FADE_FPS_INTERVAL = 1 / 60
SMOOTH_SPEED = 0.15
UNIVERSES = range(1, 9)


def _clamp_dmx_byte(value: float) -> int:
    try:
        return max(0, min(255, int(value)))
    except (TypeError, ValueError):
        return 0


class AsyncArtNetController:
    def __init__(self, zone_id: int, target_ip: str, target_port: int, bus: EventBus, instance_id: str = "") -> None:
        self.zone_id = zone_id
        self.target_ip = target_ip
        self.target_port = target_port
        self.bus = bus
        self.instance_id = instance_id

        self._sock: socket.socket | None = None
        self._sequence = 0
        self._fader_task: asyncio.Task | None = None
        self._running = False

        self.current_colors: dict[int, list[float]] = {i: [0.0, 0.0, 0.0] for i in UNIVERSES}
        self.target_colors: dict[int, list[int]] = {i: [0, 0, 0] for i in UNIVERSES}

    async def connect(self) -> bool:
        try:
            self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self._sock.setblocking(False)
        except OSError as exc:
            self._publish_error(f"socket create failed: {exc}")
            return False

        self._running = True
        self._fader_task = asyncio.create_task(self._fader_loop())
        return True

    def is_connected(self) -> bool:
        return self._sock is not None and self._running

    async def disconnect(self) -> None:
        self._running = False
        if self._fader_task:
            self._fader_task.cancel()
        if self._sock:
            self._sock.close()
            self._sock = None

    def update_led(self, led_num: int, r: int, g: int, b: int) -> bool:
        """Values are clamped here because unvalidated r/g/b would otherwise eventually reach _send_current_buffer's bytes(dmx_data) and raise, silently killing the fire-and-forget fader task until reconnect."""
        if led_num not in self.target_colors:
            return False
        self.target_colors[led_num] = [_clamp_dmx_byte(r), _clamp_dmx_byte(g), _clamp_dmx_byte(b)]
        return True

    def all_off(self) -> None:
        for i in UNIVERSES:
            self.target_colors[i] = [0, 0, 0]

    async def emergency_stop(self) -> None:
        """Unlike all_off(), snaps colors to black and sends synchronously here rather than via the fader loop, so the hardware reaches a safe state the instant this call returns (fader easing would take ~0.5-0.7s)."""
        for i in UNIVERSES:
            self.current_colors[i] = [0.0, 0.0, 0.0]
            self.target_colors[i] = [0, 0, 0]
        await self._send_current_buffer()

    async def _fader_loop(self) -> None:
        while self._running:
            changed = False
            for i in UNIVERSES:
                current, target = self.current_colors[i], self.target_colors[i]
                for c in range(3):
                    diff = target[c] - current[c]
                    if abs(diff) > 0.5:
                        step = diff * SMOOTH_SPEED
                        if abs(step) < 0.5:
                            step = 0.5 if diff > 0 else -0.5
                        current[c] += step
                        changed = True
                    else:
                        current[c] = target[c]

            if changed:
                await self._send_current_buffer()

            await asyncio.sleep(FADE_FPS_INTERVAL)

    async def _send_current_buffer(self) -> None:
        if not self._sock:
            return
        for led_num in UNIVERSES:
            r, g, b = (int(v) for v in self.current_colors[led_num])
            dmx_data = ([r, g, b] * 170)[:512]
            dmx_data += [0] * (512 - len(dmx_data))
            self._send_artnet_packet(led_num - 1, dmx_data)
            self.bus.publish(DeviceStateEvent(
                zone_id=self.zone_id,
                device_id=f"Z{self.zone_id}_light_{led_num}",
                instance_id=self.instance_id,
                channel=str(led_num - 1),  # user-facing universe is 0-based, see apply_state's own +1 comment
                device_type="light",
                state={"r": r, "g": g, "b": b},
            ))

    def _send_artnet_packet(self, universe: int, dmx_data: list[int]) -> None:
        try:
            header = b"Art-Net\x00"
            header += struct.pack("<H", 0x5000)
            header += struct.pack(">H", 14)
            header += struct.pack("B", self._sequence)
            header += struct.pack("B", 0)
            header += struct.pack("<H", universe)
            header += struct.pack(">H", 512)
            self._sock.sendto(header + bytes(dmx_data), (self.target_ip, self.target_port))
            self._sequence = (self._sequence + 1) % 256
        except OSError as exc:
            self._publish_error(f"Art-Net send failed on universe {universe}: {exc}")

    def _publish_error(self, message: str) -> None:
        logger.warning("zone %s lights: %s", self.zone_id, message)
        self.bus.publish(HardwareErrorEvent(
            zone_id=self.zone_id, subsystem="light", message=message, severity="warning",
        ))
