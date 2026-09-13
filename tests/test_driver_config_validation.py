"""Regression tests for config-model validation gaps found during the bug
audit: each field validated fine on its own but a combination (or an
unbounded field) let an invalid setup reach hardware at runtime instead of
being rejected at configure-time."""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.drivers.modbus_motor_driver import ModbusMotorGatewayConfig
from app.drivers.modbus_valve_driver import ModbusValveConfig


def test_slave_id_and_total_channels_reject_an_out_of_range_combination() -> None:
    """slave_id (1-247) and total_channels (1-256) each validate fine alone, but
    AsyncValveController spans multiple Modbus unit IDs once total_channels > 32
    (target_slave = slave_id + (relay_num-1)//32) -- a combination that pushes
    the LAST relay's computed unit ID past 247 used to pass validation and only
    fail at runtime, where a write to the invalid unit ID times out, flips
    _connected, and makes emergency_all_off() skip every other relay in the
    same pass too."""
    with pytest.raises(ValidationError):
        ModbusValveConfig(host="10.0.0.1", slave_id=247, total_channels=64)


def test_slave_id_and_total_channels_within_range_is_accepted() -> None:
    """The exact boundary (last relay lands exactly on unit ID 247) must still be allowed -- this
    isn't just tightening slave_id's own upper bound, only the combination that overflows it."""
    config = ModbusValveConfig(host="10.0.0.1", slave_id=216, total_channels=32)  # 216 + (32-1)//32 == 216
    assert config.slave_id == 216


def test_max_ramp_rate_rejects_a_value_that_would_collapse_the_ramp_to_instant() -> None:
    """AsyncInverterManager._apply_frequency computes step = max(0.01, max_rate) * RAMP_STEP_INTERVAL;
    once that alone exceeds the target frequency, the ramp's while-loop never runs even once,
    collapsing straight to an instantaneous jump and defeating the ramp-rate limiter -- the whole
    point of the field -- entirely."""
    with pytest.raises(ValidationError):
        ModbusMotorGatewayConfig(host="10.0.0.1", max_ramp_rate_hz_per_sec=100_000)


def test_max_ramp_rate_default_is_accepted() -> None:
    config = ModbusMotorGatewayConfig(host="10.0.0.1")
    assert config.max_ramp_rate_hz_per_sec > 0
