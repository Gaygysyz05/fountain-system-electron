"""
Async pub/sub replacing pyqtSignal. Hardware modules and the scenario player
call `bus.publish(event)` without knowing who — if anyone — is listening.
Each WebSocket connection subscribes its own queue and forwards to its client.
"""
from __future__ import annotations

import asyncio
import logging

from app.protocol import Event

logger = logging.getLogger("fountain.event_bus")


class EventBus:
    def __init__(self, queue_size: int = 1000) -> None:
        self._queue_size = queue_size
        self._subscribers: set[asyncio.Queue[Event]] = set()

    def subscribe(self) -> "asyncio.Queue[Event]":
        q: asyncio.Queue[Event] = asyncio.Queue(maxsize=self._queue_size)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: "asyncio.Queue[Event]") -> None:
        self._subscribers.discard(q)

    def publish(self, event: Event) -> None:
        for q in list(self._subscribers):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                # A slow/stuck client must never block hardware control flow.
                # Drop the oldest queued event for that client and retry once.
                try:
                    q.get_nowait()
                    q.put_nowait(event)
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    logger.warning("subscriber queue saturated, dropping event: %s", event)
