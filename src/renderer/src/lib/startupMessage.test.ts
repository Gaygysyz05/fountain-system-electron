import { describe, expect, it } from "vitest";
import { startupMessage } from "./startupMessage";

describe("startupMessage", () => {
  it("describes the starting phase", () => {
    expect(startupMessage({ phase: "starting" })).toBe("Starting the control daemon…");
  });

  it("includes the attempt count while restarting", () => {
    expect(startupMessage({ phase: "restarting", attempt: 2, maxAttempts: 5 })).toBe("Daemon restarting (attempt 2/5)…");
  });

  it("reads as still connecting once the daemon process is up", () => {
    // The daemon process itself running doesn't mean the WS handshake has
    // landed yet -- see wsClient.ts's fast-reconnect window.
    expect(startupMessage({ phase: "running" })).toBe("Connecting…");
  });

  it("returns an empty string for the failed phase", () => {
    // AppShell stops rendering the splash entirely once the daemon has
    // given up (see its showStartupSplash condition), so this value is
    // never actually shown -- this only guards the switch staying
    // exhaustive if a new phase is ever added.
    expect(startupMessage({ phase: "failed", maxAttempts: 5 })).toBe("");
  });
});
