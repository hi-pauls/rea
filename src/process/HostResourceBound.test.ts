import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  darwinGroupResidentBytes,
  DARWIN_MEMORY_SAMPLE_INTERVAL_MS,
  watchDarwinProcessGroupMemory,
} from "./DarwinMemoryWatchdog.js";
import {
  boundedLaunch,
  prepareHostResourceBound,
} from "./HostResourceBound.js";

const configured = {
  address_space_bytes: 1024 ** 3,
  file_bytes: 64 * 1024 ** 2,
  cpu_seconds: 30,
};
const request = (platform: NodeJS.Platform, environment = {}) => ({
  configured,
  prlimitVariable: "REA_TEST_PRLIMIT_COMMAND",
  environment,
  readLimits: async () => ({ ...configured, cpu_seconds: 10 }),
  platform,
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("prepareHostResourceBound", () => {
  it("wraps the producer in prlimit with the stricter inherited limits on Linux", async () => {
    const bound = await prepareHostResourceBound(
      request("linux", { REA_TEST_PRLIMIT_COMMAND: process.execPath }),
    );
    expect(bound.mechanism).toBe("prlimit");
    expect(bound.limits.cpu_seconds).toBe(10);
    expect(boundedLaunch(bound, "/tool", ["-v"])).toEqual({
      command: bound.enforcer,
      arguments: [
        `--as=${configured.address_space_bytes}:${configured.address_space_bytes}`,
        `--fsize=${configured.file_bytes}:${configured.file_bytes}`,
        "--cpu=10:10",
        "--core=0:0",
        "--",
        "/tool",
        "-v",
      ],
    });
  });

  it("refuses a relative Linux limiter", async () => {
    await expect(
      prepareHostResourceBound(
        request("linux", { REA_TEST_PRLIMIT_COMMAND: "prlimit" }),
      ),
    ).rejects.toThrow("REA_TEST_PRLIMIT_COMMAND must be absolute.");
  });

  it.skipIf(process.platform === "win32")(
    "limits CPU and file size through sh and memory through the watchdog on macOS",
    async () => {
      const bound = await prepareHostResourceBound(request("darwin"));
      expect(bound.mechanism).toBe("darwin-ulimit-rss-watchdog");
      const launch = boundedLaunch(bound, "/tool", ["-v"]);
      expect(launch.arguments.slice(3)).toEqual([
        "rea-limit",
        "30",
        String(65536),
        "/tool",
        "-v",
      ]);
      expect(launch.memoryLimitBytes).toBe(configured.address_space_bytes);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "launches the producer directly under a Job Object memory limit on Windows",
    async () => {
      const bound = await prepareHostResourceBound(request("win32"));
      expect(bound.mechanism).toBe("windows-job-object");
      expect(bound.enforcer).toMatch(/rea-windows-x64\.node$/u);
      expect(boundedLaunch(bound, "C:\\tool.exe", ["-v"])).toEqual({
        command: "C:\\tool.exe",
        arguments: ["-v"],
        memoryLimitBytes: configured.address_space_bytes,
      });
    },
  );

  it("refuses hosts without an enforceable bound", async () => {
    await expect(prepareHostResourceBound(request("freebsd"))).rejects.toThrow(
      "No resource bound can be enforced on freebsd",
    );
  });
});

describe("watchDarwinProcessGroupMemory", () => {
  it("sums resident memory of the selected process group only", () => {
    expect(
      darwinGroupResidentBytes(" 40  100\n 41  7\n40 20\ngarbage\n", 40),
    ).toBe(120 * 1024);
  });

  it("kills the group once and reports the limit after the sample passes it", () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const child = new EventEmitter() as unknown as ChildProcess;
    let resident = 100;
    watchDarwinProcessGroupMemory(child, 40, 1024 * 1024, (callback) =>
      callback(`40 ${resident}\n`),
    );
    vi.advanceTimersByTime(DARWIN_MEMORY_SAMPLE_INTERVAL_MS);
    expect(kill).not.toHaveBeenCalled();
    resident = 2048;
    vi.advanceTimersByTime(DARWIN_MEMORY_SAMPLE_INTERVAL_MS * 3);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(-40, "SIGKILL");
    expect(
      (child as unknown as { memoryLimitReached: boolean }).memoryLimitReached,
    ).toBe(true);
  });

  it("stops sampling when the child exits", () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as unknown as ChildProcess;
    const sample = vi.fn();
    watchDarwinProcessGroupMemory(child, 40, 1024, sample);
    child.emit("exit", 0, null);
    vi.advanceTimersByTime(DARWIN_MEMORY_SAMPLE_INTERVAL_MS * 3);
    expect(sample).not.toHaveBeenCalled();
  });
});
