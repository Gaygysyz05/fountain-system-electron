"""DGI900 register map/comm-source sequence (P0.03=2, P0.01=9) are fixed drive parameters, verified on real hardware; the client is owned by AsyncInverterManager (one per gateway) and only borrowed here because an RTU/TCP converter accepts one TCP connection per RS485 bus, shared by all inverters via `slave_id`."""
from __future__ import annotations

import asyncio
import logging
import random
import time
from dataclasses import dataclass
from typing import Literal, Optional

from pymodbus.client import AsyncModbusTcpClient

from app.event_bus import EventBus
from app.protocol import ConnectionStateEvent, DeviceStateEvent, HardwareErrorEvent, Subsystem

logger = logging.getLogger("fountain.hardware.inverter")

P0_01_ADDR = 0xF001
P0_03_ADDR = 0xF003
P0_06_ADDR = 0xF006

REG_SETPOINT_PCT = 0x5000
REG_OUT_FREQ = 0x5001
REG_BUS_VOLT = 0x5002
REG_OUT_CURR = 0x5004
REG_CTRL_WORD = 0x6000

CMD_FORWARD = 1
CMD_REVERSE = 2
CMD_FREE_STOP = 5      # emergency: cuts output immediately, no decel ramp
CMD_DECEL_STOP = 6     # normal stop: drive ramps down per its own P-params
CMD_FAULT_RESET = 7


@dataclass
class InverterStatus:
    frequency: float
    bus_voltage: Optional[int]
    current: Optional[float]
    is_running: bool
    timestamp: float
    slave_id: int


class AsyncInverterController:
    def __init__(
        self,
        zone_id: int,
        client: AsyncModbusTcpClient,
        bus_lock: asyncio.Lock,
        slave_id: int,
        motor_id: int,
        bus: EventBus,
        instance_id: str = "",
        subsystem: Subsystem = "motor",
        min_command_interval: float = 0.025,
        timeout: float = 0.5,
    ) -> None:
        self.zone_id = zone_id
        self.slave_id = slave_id
        self.motor_id = motor_id
        self.bus = bus
        self.instance_id = instance_id
        self.subsystem = subsystem
        self.min_command_interval = min_command_interval
        self.timeout = timeout

        self._client = client  # shared across every unit on this gateway -- borrowed, never owned or closed here

        # Shared Lock serializes wire transactions across all controllers on this gateway (one RS485 bus); scoped to only the read/write call, not ramp sleeps, so one motor's ramp can't block another's command.
        self._bus_lock = bus_lock

        self._connected = False
        self._write_lock = asyncio.Lock()  # per-unit: throttles THIS motor's own consecutive commands
        self._last_command_time = 0.0

        self.max_frequency = 50.0
        self.last_frequency: float | None = None
        self.last_command: int | None = None
        self.current_status = InverterStatus(0.0, None, None, False, 0.0, slave_id)

    # -- lifecycle ------------------------------------------------------------

    async def connect(self) -> bool:
        """Per-unit bring-up over the shared TCP link; the link itself is AsyncInverterManager's responsibility."""
        if not self._client.connected:
            self._publish_error(f"shared connection not established (slave {self.slave_id})")
            self._connected = False
            return False

        # Stagger simultaneous bring-up of multiple units on the same bus.
        await asyncio.sleep(random.uniform(0.05, 0.2))

        self._connected = True
        if not await self._ensure_comm_sources():
            self._publish_error(f"comm source setup failed for slave {self.slave_id}")
            self._connected = False
            return False

        await self._read_max_frequency()
        self.bus.publish(ConnectionStateEvent(zone_id=self.zone_id, subsystem=self.subsystem, connected=True,
                                               detail=f"slave {self.slave_id}"))
        return True

    async def disconnect(self) -> None:
        self._connected = False
        self.bus.publish(ConnectionStateEvent(zone_id=self.zone_id, subsystem=self.subsystem, connected=False,
                                               detail=f"slave {self.slave_id}"))

    def is_connected(self) -> bool:
        return self._connected and self._client.connected

    # -- register I/O -----------------------------------------------------------

    async def _read_register(self, addr: int) -> int | None:
        if not self._connected or not self._client.connected:
            return None
        try:
            async with self._bus_lock:
                result = await asyncio.wait_for(
                    self._client.read_holding_registers(address=addr, count=1, device_id=self.slave_id),
                    timeout=self.timeout,
                )
            if result.isError():
                return None
            return result.registers[0]
        except Exception as exc:  # noqa: BLE001
            self._connected = False
            self._publish_error(f"read register 0x{addr:04X} failed: {exc}")
            return None

    async def _write_register(self, addr: int, value: int) -> bool:
        if not self._connected or not self._client.connected:
            return False

        async with self._write_lock:
            elapsed = time.monotonic() - self._last_command_time
            if elapsed < self.min_command_interval:
                await asyncio.sleep(self.min_command_interval - elapsed)

            # Only a genuine transport failure (timeout/socket error) should flip `_connected`; a Modbus exception response means the drive answered but rejected this write, and must not disconnect other motors sharing the bus (see modbus_valve.py's _write_relay for the same fix).
            try:
                async with self._bus_lock:
                    result = await asyncio.wait_for(
                        self._client.write_register(address=addr, value=value, device_id=self.slave_id),
                        timeout=self.timeout,
                    )
            except Exception as exc:  # noqa: BLE001
                self._connected = False
                self._publish_error(f"write register 0x{addr:04X} failed: {exc}")
                self.bus.publish(ConnectionStateEvent(zone_id=self.zone_id, subsystem=self.subsystem,
                                                       connected=False, detail=f"slave {self.slave_id}"))
                return False

            if result.isError():
                self._publish_error(f"register 0x{addr:04X} write rejected by controller: {result}")
                return False

            self._last_command_time = time.monotonic()
            return True

    async def _ensure_comm_sources(self) -> bool:
        p03 = await self._read_register(P0_03_ADDR)
        p01 = await self._read_register(P0_01_ADDR)
        if p03 is None or p01 is None:
            return False
        ok = True
        if p03 != 2:
            ok &= await self._write_register(P0_03_ADDR, 2)
        if p01 != 9:
            ok &= await self._write_register(P0_01_ADDR, 9)
        return ok

    async def _read_max_frequency(self) -> None:
        value = await self._read_register(P0_06_ADDR)
        self.max_frequency = (value / 100.0) if value is not None else 50.0

    def _hz_to_percent(self, hz: float) -> int:
        if self.max_frequency <= 0:
            return 0
        return max(-10000, min(10000, int(round(hz / self.max_frequency * 10000))))

    # -- commands ----------------------------------------------------------------

    async def set_frequency(self, frequency: float) -> bool:
        if not self._connected or not (0 <= frequency <= self.max_frequency):
            return False
        if self.last_frequency is not None and abs(frequency - self.last_frequency) < 0.1:
            return True
        success = await self._write_register(REG_SETPOINT_PCT, self._hz_to_percent(frequency))
        if success:
            self.last_frequency = frequency
        return success

    async def send_command(self, command: int) -> bool:
        if not self._connected:
            return False
        if self.last_command == command:
            return True
        success = await self._write_register(REG_CTRL_WORD, command)
        if success:
            self.last_command = command
        return success

    async def start_forward(self, frequency: float | None = None) -> bool:
        if frequency is not None and not await self.set_frequency(frequency):
            return False
        ok = await self.send_command(CMD_FORWARD)
        if ok:
            self._publish_state(active=True)
        return ok

    async def stop(self) -> bool:
        """Normal stop: drive decelerates per its own configured ramp (P-params)."""
        self.last_command = None
        self.last_frequency = None
        ok = await self._write_register(REG_CTRL_WORD, CMD_DECEL_STOP)
        if ok:
            self._publish_state(active=False)
        return ok

    async def emergency_stop(self) -> bool:
        """Bypasses the interval throttle and dedup: an E-stop must go out even if a command was just sent."""
        self.last_command = None
        self.last_frequency = None
        if not self._connected or not self._client.connected:
            return False
        try:
            async with self._bus_lock:
                result = await asyncio.wait_for(
                    self._client.write_register(address=REG_CTRL_WORD, value=CMD_FREE_STOP, device_id=self.slave_id),
                    timeout=self.timeout,
                )
            if result.isError():
                self._publish_error(f"E-STOP write failed for slave {self.slave_id}")
                return False
            self._publish_state(active=False)
            return True
        except Exception as exc:  # noqa: BLE001
            self._connected = False
            self._publish_error(f"E-STOP raised for slave {self.slave_id}: {exc}")
            return False

    async def reset_fault(self) -> bool:
        """Bypasses send_command's dedup so a second reset after the drive re-trips isn't silently no-op'd."""
        self.last_command = None
        return await self._write_register(REG_CTRL_WORD, CMD_FAULT_RESET)

    async def read_status(self) -> InverterStatus | None:
        if not self._connected or not self._client.connected:
            return None
        try:
            async with self._bus_lock:
                result = await asyncio.wait_for(
                    self._client.read_holding_registers(address=REG_OUT_FREQ, count=4, device_id=self.slave_id),
                    timeout=self.timeout,
                )
            if result.isError():
                return None
            regs = result.registers
            frequency, bus_voltage, current = regs[0] / 100.0, regs[1], regs[3] / 100.0
            is_running = frequency > 0.5

            if (abs(frequency - self.current_status.frequency) < 0.2
                    and self.current_status.is_running == is_running):
                return self.current_status

            self.current_status = InverterStatus(frequency, bus_voltage, current, is_running, time.time(), self.slave_id)
            self.bus.publish(DeviceStateEvent(
                zone_id=self.zone_id,
                device_id=f"Z{self.zone_id}_{self.subsystem}_{self.motor_id}",
                instance_id=self.instance_id,
                channel=str(self.slave_id),
                device_type=self.subsystem,  # type: ignore[arg-type]
                state={"frequency": frequency, "bus_voltage": bus_voltage, "current": current, "is_running": is_running},
            ))
            return self.current_status
        except Exception as exc:  # noqa: BLE001
            self._connected = False
            self._publish_error(f"status read failed: {exc}")
            return None

    def _publish_state(self, active: bool) -> None:
        self.bus.publish(DeviceStateEvent(
            zone_id=self.zone_id,
            device_id=f"Z{self.zone_id}_{self.subsystem}_{self.motor_id}",
            instance_id=self.instance_id,
            channel=str(self.slave_id),
            device_type=self.subsystem,  # type: ignore[arg-type]
            state={"frequency": self.last_frequency or 0.0, "active": active},
        ))

    def _publish_error(self, message: str) -> None:
        logger.warning("zone %s %s slave %s: %s", self.zone_id, self.subsystem, self.slave_id, message)
        self.bus.publish(HardwareErrorEvent(zone_id=self.zone_id, subsystem=self.subsystem, message=message, severity="warning"))
