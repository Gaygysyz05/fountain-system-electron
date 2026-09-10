import { describe, expect, it } from "vitest";
import { formatTime } from "./formatTime";

describe("formatTime", () => {
  it("does not zero-pad minutes under 10 -- the exact drift that used to differ between screens", () => {
    // LiveTimecode.tsx's own copy used to read "01:05" for this input while
    // ScenarioTimelinePlayer.tsx/PianoRollEditor.tsx's read "1:05" for the
    // same position -- consolidating onto one implementation means every
    // screen now agrees with the majority (unpadded) convention.
    expect(formatTime(65)).toBe("1:05");
  });

  it("pads seconds under 10", () => {
    expect(formatTime(61)).toBe("1:01");
  });

  it("formats a whole number of minutes with :00 seconds", () => {
    expect(formatTime(120)).toBe("2:00");
  });

  it("formats zero", () => {
    expect(formatTime(0)).toBe("0:00");
  });

  it("truncates (does not round) fractional seconds", () => {
    expect(formatTime(59.9)).toBe("0:59");
  });

  it("handles durations of 10+ minutes without special-casing", () => {
    expect(formatTime(725)).toBe("12:05");
  });
});
