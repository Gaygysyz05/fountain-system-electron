import { describe, expect, it } from "vitest";
import { JET_MOTOR_MAX_FREQUENCY, JET_MOTOR_MAX_HEIGHT, JET_VALVE_HEIGHT, jetState } from "./waterJet";

describe("jetState", () => {
  it("a valve is visible at a fixed height only when on", () => {
    expect(jetState("valve", { on: true })).toEqual({ visible: true, height: JET_VALVE_HEIGHT });
    expect(jetState("valve", { on: false })).toEqual({ visible: false, height: JET_VALVE_HEIGHT });
    expect(jetState("valve", undefined)).toEqual({ visible: false, height: JET_VALVE_HEIGHT });
  });

  it("a motor is hidden while inactive even if frequency is nonzero (stale/pre-stop value)", () => {
    expect(jetState("motor", { active: false, frequency: 30 })).toEqual({ visible: false, height: expect.any(Number) });
  });

  it("a motor is hidden at zero frequency even if active", () => {
    expect(jetState("motor", { active: true, frequency: 0 })).toEqual({ visible: false, height: expect.any(Number) });
  });

  it("a motor's jet height scales linearly with frequency up to the max", () => {
    const half = jetState("motor", { active: true, frequency: JET_MOTOR_MAX_FREQUENCY / 2 });
    expect(half.visible).toBe(true);
    expect(half.height).toBeCloseTo(JET_MOTOR_MAX_HEIGHT / 2, 5);

    const full = jetState("motor", { active: true, frequency: JET_MOTOR_MAX_FREQUENCY });
    expect(full.height).toBeCloseTo(JET_MOTOR_MAX_HEIGHT, 5);
  });

  it("a motor's jet height is clamped, not overshooting past the max for a frequency above it", () => {
    const over = jetState("motor", { active: true, frequency: JET_MOTOR_MAX_FREQUENCY * 3 });
    expect(over.height).toBeCloseTo(JET_MOTOR_MAX_HEIGHT, 5);
  });

  it("a light device (not wired to a jet) is never visible", () => {
    expect(jetState("light", { r: 255, g: 255, b: 255 })).toEqual({ visible: false, height: 0 });
  });
});
