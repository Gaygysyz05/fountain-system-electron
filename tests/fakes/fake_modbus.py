"""
A real Modbus TCP server (raw sockets, no pymodbus) standing in for an
actual relay board / VFD gateway during tests. The daemon's driver code
talks to it over an actual TCP socket exactly like real hardware -- nothing
in app/hardware is aware it isn't real -- which is what lets these tests
exercise the daemon's own transport-vs-protocol-error handling instead of
mocking that logic away.

Supports only what the daemon's drivers actually use: function code 0x03
(read holding registers) and 0x06 (write single register). Failure modes are
configured per register address so a test can reject exactly one relay's
write (a Modbus *exception* response -- the board is alive and answered, it
just rejected that transaction) while everything else on the same connection
keeps working, or drop the TCP connection entirely (a genuine transport
failure) to exercise the other code path.
"""
from __future__ import annotations

import asyncio
import struct

ILLEGAL_DATA_ADDRESS = 0x02


class FakeModbusServer:
    def __init__(self, registers: dict[int, int] | None = None) -> None:
        self.registers: dict[int, int] = dict(registers or {})
        # (unit_id, address, value) for every write the server accepted OR rejected --
        # a rejected write still reached the wire, which is exactly the
        # "board alive, transaction rejected" case these tests care about.
        self.received_writes: list[tuple[int, int, int]] = []
        # address -> exception responses remaining before it starts succeeding.
        # None/absent = never rejected. Use a huge number for "always reject".
        self.reject_writes: dict[int, int] = {}
        self.reject_reads: dict[int, int] = {}
        # Closing the socket after N total requests simulates a genuine
        # transport failure (cable pulled, gateway rebooted) instead of a
        # protocol-level rejection.
        self.drop_after_n_requests: int | None = None
        self._request_count = 0

        self.host = "127.0.0.1"
        self.port = 0
        self._server: asyncio.base_events.Server | None = None
        self._writers: set[asyncio.StreamWriter] = set()

    async def start(self) -> "FakeModbusServer":
        self._server = await asyncio.start_server(self._handle_client, self.host, 0)
        self.port = self._server.sockets[0].getsockname()[1]
        return self

    async def stop(self) -> None:
        # A client that's never explicitly closed (easy to forget in a test
        # -- AsyncInverterController in particular borrows a client it never
        # owns, so tests that construct one directly must close it
        # themselves) leaves _handle_client blocked forever on readexactly()
        # waiting for more bytes that will never come. wait_closed() then
        # hangs waiting for that handler task, which looks exactly like the
        # daemon itself hanging. Force every open connection closed here so
        # a forgotten client.close() in a test fails that test, not the
        # whole suite.
        if self._server:
            self._server.close()
            for writer in list(self._writers):
                writer.close()
            await self._server.wait_closed()

    async def __aenter__(self) -> "FakeModbusServer":
        return await self.start()

    async def __aexit__(self, *exc: object) -> None:
        await self.stop()

    async def _handle_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._writers.add(writer)
        try:
            while True:
                header = await reader.readexactly(7)
                txn_id, _proto_id, length, unit_id = struct.unpack(">HHHB", header)
                pdu = await reader.readexactly(length - 1)

                self._request_count += 1
                if self.drop_after_n_requests is not None and self._request_count > self.drop_after_n_requests:
                    writer.close()
                    return

                response_pdu = self._handle_pdu(unit_id, pdu)
                if response_pdu is None:
                    continue  # simulated hang: no response, let the client's own timeout fire

                resp_header = struct.pack(">HHHB", txn_id, 0, len(response_pdu) + 1, unit_id)
                writer.write(resp_header + response_pdu)
                await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionResetError, BrokenPipeError):
            pass
        finally:
            self._writers.discard(writer)
            writer.close()

    def _handle_pdu(self, unit_id: int, pdu: bytes) -> bytes | None:
        fc = pdu[0]

        if fc == 0x03:  # read holding registers
            addr, count = struct.unpack(">HH", pdu[1:5])
            remaining = self.reject_reads.get(addr, 0)
            if remaining > 0:
                self.reject_reads[addr] = remaining - 1
                return bytes([fc | 0x80, ILLEGAL_DATA_ADDRESS])
            values = [self.registers.get(addr + i, 0) for i in range(count)]
            data = b"".join(struct.pack(">H", v) for v in values)
            return bytes([fc, len(data)]) + data

        if fc == 0x06:  # write single register
            addr, value = struct.unpack(">HH", pdu[1:5])
            self.received_writes.append((unit_id, addr, value))
            remaining = self.reject_writes.get(addr, 0)
            if remaining > 0:
                self.reject_writes[addr] = remaining - 1
                return bytes([fc | 0x80, ILLEGAL_DATA_ADDRESS])
            self.registers[addr] = value
            return pdu[:5]  # success echoes the request PDU back

        return bytes([fc | 0x80, 0x01])  # illegal function -- not used by any current driver
