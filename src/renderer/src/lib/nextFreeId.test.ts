import { describe, expect, it } from "vitest";
import { nextFreeId, nextFreeIds } from "./nextFreeId";

describe("nextFreeId", () => {
  it("returns start when nothing is used", () => {
    expect(nextFreeId(new Set(), 1)).toBe("1");
  });

  it("skips used ids", () => {
    expect(nextFreeId(new Set(["1", "2"]), 1)).toBe("3");
  });

  it("finds a gap rather than only ever appending past the max used id", () => {
    expect(nextFreeId(new Set(["1", "3"]), 1)).toBe("2");
  });

  it("falls back to start when every id up to limit is used", () => {
    // Matches DeviceConfigPanel's suggestNextChannel behavior on a
    // fully-populated Node8 -- the field still needs SOME value to
    // pre-fill, even a taken one, so the operator has something to
    // overwrite rather than an empty box.
    expect(nextFreeId(new Set(["1", "2", "3"]), 1, 3)).toBe("1");
  });
});

describe("nextFreeIds", () => {
  it("returns the requested count of free ids in ascending order", () => {
    expect(nextFreeIds(new Set(["1"]), 1, 2)).toEqual(["2", "3"]);
  });

  it("returns fewer than count when limit is exhausted", () => {
    expect(nextFreeIds(new Set(), 1, 5, 2)).toEqual(["1", "2"]);
  });
});
