"""Shares one AsyncModbusTcpClient per gateway (the RTU/TCP bridge accepts only one connection) across all motors; each motor has its own queue+consumer task, coordinated only by a shared `asyncio.Lock` scoped tightly around each wire transaction (not whole ramps) so independent ramps never head-of-line-block each other. `_apply_frequency` ramps toward the target at a configurable max Hz/sec as defense in depth beyond the drive's own accel/decel params, and bails early if a newer command was coalesced in; EMERGENCY_STOP bypasses all queueing and ramping."""
from __future__ import annotations

import asyncio
import contextlib
import logging

from pymodbus.client import AsyncModbusTcpClient

from app.event_bus import EventBus
from app.hardware.modbus_inverter import AsyncInverterController
from app.protocol import Subsystem

logger = logging.getLogger("fountain.hardware.inverter_manager")

_CommandType = tuple[str, dict | None]  # ('frequency', params) | ('forward', None) | ('stop', None)

DEFAULT_MAX_RAMP_RATE_HZ_PER_SEC = 5.0  # tune per pump/plumbing inertia
RAMP_STEP_INTERVAL = 0.15  # seconds between intermediate setpoint writes


class AsyncInverterManager:
    def __init__(
        self,
        zone_id: int,
        host: str,
        port: int,
        bus: EventBus,
        instance_id: str = "",
        subsystem: Subsystem = "motor",
        max_ramp_rate_hz_per_sec: float = DEFAULT_MAX_RAMP_RATE_HZ_PER_SEC,
    ) -> None:
        self.zone_id = zone_id
        self.host = host
        self.port = port
        self.bus = bus
        self.instance_id = instance_id
        self.subsystem = subsystem
        self.max_ramp_rate_hz_per_sec = max_ramp_rate_hz_per_sec

        self._client = AsyncModbusTcpClient(host=host, port=port, timeout=2.0)
        self._bus_lock = asyncio.Lock()  # shared by every controller below -- see module docstring

        self.inverters: dict[int, AsyncInverterController] = {}
        self._queues: dict[int, asyncio.Queue[_CommandType]] = {}
        self._consumer_tasks: dict[int, asyncio.Task] = {}
        self._poll_task: asyncio.Task | None = None
        self._reconnect_task: asyncio.Task | None = None
        self._closing = False

    # -- inverter lifecycle ---------------------------------------------------

    def add_inverter(self, motor_id: int, slave_id: int) -> bool:
        if slave_id in self.inverters:
            return True
        if not (1 <= motor_id <= 255) or not (1 <= slave_id <= 247):
            return False

        self.inverters[slave_id] = AsyncInverterController(
            zone_id=self.zone_id, client=self._client, bus_lock=self._bus_lock,
            slave_id=slave_id, motor_id=motor_id, bus=self.bus,
            instance_id=self.instance_id, subsystem=self.subsystem,
        )
        self._queues[slave_id] = asyncio.Queue(maxsize=1)
        return True

    async def connect_inverter(self, slave_id: int) -> bool:
        controller = self.inverters.get(slave_id)
        if not controller:
            return False

        if not self._client.connected:
            try:
                await self._client.connect()
            except Exception as exc:  # noqa: BLE001
                logger.warning("zone %s: shared link %s:%s connect failed: %s", self.zone_id, self.host, self.port, exc)

        ok = await controller.connect()

        if ok and (slave_id not in self._consumer_tasks or self._consumer_tasks[slave_id].done()):
            self._consumer_tasks[slave_id] = asyncio.create_task(self._consumer(slave_id))
        if not self._poll_task or self._poll_task.done():
            self._poll_task = asyncio.create_task(self._poll_loop())
        if not self._reconnect_task or self._reconnect_task.done():
            self._reconnect_task = asyncio.create_task(self._reconnect_watchdog())

        return ok

    async def connect_all(self) -> dict[int, bool]:
        results = await asyncio.gather(*(self.connect_inverter(sid) for sid in self.inverters))
        return dict(zip(self.inverters.keys(), results))

    async def disconnect_inverter(self, slave_id: int) -> None:
        if task := self._consumer_tasks.pop(slave_id, None):
            task.cancel()
        if controller := self.inverters.get(slave_id):
            await controller.disconnect()

    async def disconnect_all(self) -> None:
        self._closing = True
        for task in (self._poll_task, self._reconnect_task):
            if task:
                task.cancel()
        self._poll_task = self._reconnect_task = None

        await asyncio.gather(*(self.disconnect_inverter(sid) for sid in list(self.inverters.keys())))

        if self._client.connected:
            self._client.close()

    def is_connected(self, slave_id: int) -> bool:
        controller = self.inverters.get(slave_id)
        return controller.is_connected() if controller else False

    # -- fire-and-forget command surface (mirrors the original API) ----------

    def execute_motor_event(self, slave_id: int, event_params: dict) -> bool:
        return self._enqueue(slave_id, ("frequency", event_params))

    def start_motor_forward(self, slave_id: int) -> bool:
        return self._enqueue(slave_id, ("forward", None))

    def stop_motor(self, slave_id: int) -> bool:
        return self._enqueue(slave_id, ("stop", None))

    async def execute_motor_event_immediate(self, slave_id: int, event_params: dict) -> bool:
        """Bypasses the queue and awaits the result directly -- no thread-bridging hack needed since the caller can just await us."""
        controller = self.inverters.get(slave_id)
        if not controller:
            return False
        return await self._apply_frequency(slave_id, controller, event_params)

    async def reset_fault(self, slave_id: int) -> bool:
        """Bypasses the queue -- a fault reset must not wait behind the stale command that caused the fault in the first place."""
        controller = self.inverters.get(slave_id)
        if not controller:
            return False
        return await controller.reset_fault()

    def _enqueue(self, slave_id: int, cmd: _CommandType) -> bool:
        queue = self._queues.get(slave_id)
        if queue is None:
            logger.warning("motor %s not registered on %s:%s", slave_id, self.host, self.port)
            return False
        try:
            queue.put_nowait(cmd)
        except asyncio.QueueFull:
            try:
                queue.get_nowait()  # drop the stale pending command, keep only the latest
            except asyncio.QueueEmpty:
                pass
            queue.put_nowait(cmd)
        return True

    async def _consumer(self, slave_id: int) -> None:
        """One task per motor for independent ramps; wire safety comes from `_bus_lock` in modbus_inverter.py, not from serializing here."""
        controller = self.inverters[slave_id]
        queue = self._queues[slave_id]
        while True:
            cmd_type, params = await queue.get()
            try:
                if cmd_type == "frequency":
                    await self._apply_frequency(slave_id, controller, params or {}, queue)
                elif cmd_type == "forward":
                    await controller.start_forward()
                elif cmd_type == "stop":
                    await controller.stop()
            except Exception:  # noqa: BLE001 - one bad command must not kill this motor's consumer
                logger.exception("motor %s: command %s failed", slave_id, cmd_type)

    async def _apply_frequency(
        self, slave_id: int, controller: AsyncInverterController, params: dict,
        queue: "asyncio.Queue[_CommandType] | None" = None,
    ) -> bool:
        target = params.get("frequency", 0.0)
        active = params.get("active", True)
        max_rate = params.get("max_ramp_rate", self.max_ramp_rate_hz_per_sec)

        if not active or target <= 0:
            return await controller.stop()  # drive's own decel ramp handles the graceful part

        current = controller.last_frequency or 0.0
        step = max(0.01, max_rate) * RAMP_STEP_INTERVAL

        while abs(target - current) > step:
            if queue is not None and not queue.empty():
                # A fresher target is already queued -- bail so the consumer re-invokes us with it.
                return True
            current += step if target > current else -step
            if not await controller.start_forward(current):
                return False
            await asyncio.sleep(RAMP_STEP_INTERVAL)

        return await controller.start_forward(target)

    # -- bulk stop -------------------------------------------------------------

    async def emergency_stop_all(self) -> int:
        """Bypasses every queue and cancels each motor's consumer task before stopping it, because an in-flight ramp only bails on a NEWER queued command (not an empty queue) and would otherwise keep stepping toward its pre-E-stop target for seconds after this returns; tasks are restarted after so their queues aren't left with no reader."""
        logger.warning("EMERGENCY stop all motors on %s:%s", self.host, self.port)
        for queue in self._queues.values():
            while not queue.empty():
                queue.get_nowait()

        for task in self._consumer_tasks.values():
            task.cancel()
        for task in list(self._consumer_tasks.values()):
            with contextlib.suppress(asyncio.CancelledError):
                await task

        async def _stop_one(controller: AsyncInverterController) -> bool:
            try:
                return await asyncio.wait_for(controller.emergency_stop(), timeout=1.0)
            except (asyncio.TimeoutError, Exception):  # noqa: BLE001
                return False

        connected = [c for c in self.inverters.values() if c.is_connected()]
        results = await asyncio.gather(*(_stop_one(c) for c in connected))
        stopped = sum(results)
        logger.warning("emergency stop: %s/%s motors confirmed stopped", stopped, len(connected))

        if not self._closing:
            for slave_id in self.inverters:
                if slave_id not in self._consumer_tasks or self._consumer_tasks[slave_id].done():
                    self._consumer_tasks[slave_id] = asyncio.create_task(self._consumer(slave_id))

        return stopped

    async def stop_all(self) -> int:
        for queue in self._queues.values():
            while not queue.empty():
                queue.get_nowait()

        stopped = 0
        for slave_id, controller in sorted(self.inverters.items()):
            if not controller.is_connected():
                continue
            if await controller.stop():
                stopped += 1
            await asyncio.sleep(0.025)
        return stopped

    async def _poll_loop(self) -> None:
        while True:
            await asyncio.sleep(3.0)
            connected = [c for c in self.inverters.values() if c.is_connected()]
            if connected:
                await asyncio.gather(*(c.read_status() for c in connected), return_exceptions=True)

    async def _reconnect_watchdog(self) -> None:
        """Needed because the RTU/TCP converter drops and needs reconnecting like any serial gateway."""
        while not self._closing:
            await asyncio.sleep(1.0)
            if self._closing:
                return

            if not self._client.connected:
                logger.info("zone %s: reconnecting shared modbus link %s:%s", self.zone_id, self.host, self.port)
                try:
                    await self._client.connect()
                except Exception:  # noqa: BLE001
                    continue

            if self._client.connected:
                for controller in self.inverters.values():
                    if not controller.is_connected():
                        await controller.connect()
