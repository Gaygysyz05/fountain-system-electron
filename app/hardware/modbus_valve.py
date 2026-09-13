"""Async, event-bus-driven valve controller; enforces min_toggle_interval per relay as a hardware safety interlock and auto-reconnects via a background watchdog."""
from __future__ import annotations

import asyncio
import contextlib
import logging
import time

from pymodbus.client import AsyncModbusTcpClient

from app.event_bus import EventBus
from app.protocol import ConnectionStateEvent, DeviceStateEvent, HardwareErrorEvent, Severity

logger = logging.getLogger("fountain.hardware.valve")

ON_VALUE = 0x0100
OFF_VALUE = 0x0200


class AsyncValveController:
    def __init__(
        self,
        zone_id: int,
        host: str,
        port: int,
        slave_id: int,
        total_channels: int,
        bus: EventBus,
        instance_id: str = "",
        min_toggle_interval: float = 0.25,  # conservative default -- tune to the valve/relay datasheet
        write_timeout: float = 2.0,
    ) -> None:
        self.zone_id = zone_id
        self.host = host
        self.port = port
        self.slave_id = slave_id
        self.total_channels = total_channels
        self.bus = bus
        self.instance_id = instance_id
        self.min_toggle_interval = min_toggle_interval
        self.write_timeout = write_timeout

        self._client: AsyncModbusTcpClient | None = None
        self._connected = False
        self._closing = False

        self._command_queue: asyncio.Queue[dict[int, bool]] = asyncio.Queue(maxsize=100)
        self._last_known_states: dict[int, bool] = {}
        self._last_command_time: dict[int, float] = {}

        self._consumer_task: asyncio.Task | None = None
        self._watchdog_task: asyncio.Task | None = None
        self._reconnect_delay = 0.5
        self._max_reconnect_delay = 5.0

    # -- lifecycle ---------------------------------------------------------

    async def connect(self) -> bool:
        if self._client is not None:
            # Close the previous client first, or every watchdog retry leaks its socket.
            self._client.close()
        try:
            self._client = AsyncModbusTcpClient(host=self.host, port=self.port, timeout=self.write_timeout)
            await self._client.connect()
        except Exception as exc:  # noqa: BLE001 - any transport failure is reported, not raised
            self._publish_error(f"connect() raised: {exc}")
            self._connected = False
            return False

        if not self._client.connected:
            self._publish_error(f"could not reach {self.host}:{self.port}")
            self._connected = False
            return False

        self._connected = True
        self._reconnect_delay = 0.5
        self.bus.publish(ConnectionStateEvent(zone_id=self.zone_id, subsystem="valve", connected=True))

        if not self._consumer_task or self._consumer_task.done():
            self._consumer_task = asyncio.create_task(self._command_consumer())
        if not self._watchdog_task or self._watchdog_task.done():
            self._watchdog_task = asyncio.create_task(self._reconnect_watchdog())
        return True

    async def disconnect(self) -> None:
        self._closing = True
        for task in (self._consumer_task, self._watchdog_task):
            if task:
                task.cancel()

        try:
            await self.emergency_all_off()
        finally:
            if self._client:
                self._client.close()
            self._connected = False
            self.bus.publish(ConnectionStateEvent(zone_id=self.zone_id, subsystem="valve", connected=False))

    def is_connected(self) -> bool:
        return self._connected

    # -- command surface (non-blocking, mirrors the original API) ----------

    def set_valve_state(self, valve_num: int, state: bool) -> bool:
        return self._enqueue({valve_num: state})

    def set_multiple_valves_batch(self, valve_states: dict[int, bool]) -> bool:
        return self._enqueue(dict(valve_states))

    def _enqueue(self, states: dict[int, bool]) -> bool:
        try:
            self._command_queue.put_nowait(states)
            return True
        except asyncio.QueueFull:
            logger.warning("zone %s valve command queue full, dropping %s", self.zone_id, states)
            return False

    # -- internals -----------------------------------------------------------

    async def _command_consumer(self) -> None:
        """Single writer for this connection: coalesces bursts since the relay board can only process one transaction at a time."""
        while True:
            merged = dict(await self._command_queue.get())
            while not self._command_queue.empty():
                merged.update(self._command_queue.get_nowait())

            for valve_num, new_state in merged.items():
                if self._last_known_states.get(valve_num) == new_state:
                    continue

                await self._respect_min_interval(valve_num)
                ok = await self._write_relay(valve_num, new_state)

                if ok:
                    self._last_known_states[valve_num] = new_state
                    self.bus.publish(DeviceStateEvent(
                        zone_id=self.zone_id,
                        device_id=f"Z{self.zone_id}_valve_{valve_num}",
                        instance_id=self.instance_id,
                        channel=str(valve_num),
                        device_type="valve",
                        state={"on": new_state},
                    ))
                else:
                    self._last_known_states.pop(valve_num, None)

    async def _respect_min_interval(self, valve_num: int) -> None:
        last = self._last_command_time.get(valve_num, 0.0)
        elapsed = time.monotonic() - last
        if elapsed < self.min_toggle_interval:
            await asyncio.sleep(self.min_toggle_interval - elapsed)
        self._last_command_time[valve_num] = time.monotonic()

    async def _write_relay(self, relay_num: int, state: bool) -> bool:
        if not 1 <= relay_num <= self.total_channels:
            return False

        if not self._connected:
            return False  # watchdog owns reconnection; don't block the tick loop retrying here

        target_slave = self.slave_id + (relay_num - 1) // 32
        relative_relay = (relay_num - 1) % 32 + 1
        value = ON_VALUE if state else OFF_VALUE

        # A Modbus exception response (result.isError()) means the board rejected this
        # transaction but is still alive -- only a transport failure below should flip `_connected`.
        try:
            result = await asyncio.wait_for(
                self._client.write_register(address=relative_relay, value=value, device_id=target_slave),
                timeout=self.write_timeout,
            )
        except Exception as exc:  # noqa: BLE001
            self._connected = False
            self._publish_error(f"write failed for relay {relay_num}: {exc}")
            self.bus.publish(ConnectionStateEvent(zone_id=self.zone_id, subsystem="valve", connected=False))
            return False

        if result.isError():
            self._publish_error(f"relay {relay_num} rejected by controller: {result}")
            return False
        return True

    async def _reconnect_watchdog(self) -> None:
        while not self._closing:
            await asyncio.sleep(1.0)
            if self._connected or self._closing:
                continue
            logger.info("zone %s valves: attempting reconnect to %s:%s", self.zone_id, self.host, self.port)
            if await self.connect():
                continue
            self._reconnect_delay = min(self._reconnect_delay * 1.5, self._max_reconnect_delay)
            await asyncio.sleep(self._reconnect_delay)

    async def emergency_all_off(self, retries: int = 2) -> int:
        """Drains the queue and stops the consumer task (awaited) first so a queued command can't race this E-stop and reopen a valve; retries unconfirmed relays and raises a critical error if any still won't confirm OFF."""
        while not self._command_queue.empty():
            self._command_queue.get_nowait()
        if self._consumer_task:
            self._consumer_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._consumer_task

        remaining = set(range(1, self.total_channels + 1))
        confirmed: set[int] = set()

        for attempt in range(retries + 1):
            for relay in sorted(remaining, reverse=True):
                if await self._write_relay(relay, False):
                    confirmed.add(relay)
                    self._last_known_states[relay] = False
            remaining -= confirmed

            if not remaining:
                break
            if attempt < retries:
                logger.warning(
                    "zone %s valves: %d relay(s) did not confirm OFF (attempt %d/%d) -- retrying: %s",
                    self.zone_id, len(remaining), attempt + 1, retries + 1, sorted(remaining),
                )
                await asyncio.sleep(0.2)

        if remaining:
            self._publish_error(
                f"emergency stop: relay(s) {sorted(remaining)} did NOT confirm OFF after {retries + 1} attempts "
                "-- check them by hand",
                severity="critical",
            )

        if not self._closing and (not self._consumer_task or self._consumer_task.done()):
            self._consumer_task = asyncio.create_task(self._command_consumer())

        return len(confirmed)

    def _publish_error(self, message: str, severity: Severity = "warning") -> None:
        logger.warning("zone %s valves: %s", self.zone_id, message)
        self.bus.publish(HardwareErrorEvent(
            zone_id=self.zone_id, subsystem="valve", message=message, severity=severity,
        ))
