"""Regression tests for _dispatch's zone-existence handling -- guards
against the zombie-zone creation bug found in this session's audit:
RECONNECT_INSTANCE/SET_DEVICE_STATE/RESET_MOTOR_FAULT used to route
through get_zone(), which silently CREATES a fresh, empty ZoneRuntime for
whatever zone_id it's handed. A mistyped or stale zone_id sent with any of
these three commands used to leave a permanent, empty phantom zone sitting
in `zones` -- visible in GET /zones forever after -- instead of failing
loudly the way ADD_DEVICE's "unknown instance" already does."""
from __future__ import annotations

import pytest

from app import main
from app.protocol import ReconnectInstance, ResetMotorFault, SetDeviceState


@pytest.fixture(autouse=True)
def _clean_zones():
    main.zones.clear()
    yield
    main.zones.clear()


async def test_reconnect_instance_on_unknown_zone_raises_and_creates_no_zone() -> None:
    with pytest.raises(RuntimeError, match="unknown zone"):
        await main._dispatch(ReconnectInstance(zone_id=99, instance_id="rele1"))
    assert 99 not in main.zones


async def test_set_device_state_on_unknown_zone_raises_and_creates_no_zone() -> None:
    with pytest.raises(RuntimeError, match="unknown zone"):
        await main._dispatch(SetDeviceState(zone_id=99, device_id="V1", parameters={"on": True}))
    assert 99 not in main.zones


async def test_reset_motor_fault_on_unknown_zone_raises_and_creates_no_zone() -> None:
    with pytest.raises(RuntimeError, match="unknown zone"):
        await main._dispatch(ResetMotorFault(zone_id=99, device_id="M1"))
    assert 99 not in main.zones
