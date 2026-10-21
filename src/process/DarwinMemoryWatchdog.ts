import { execFile, type ChildProcess } from "node:child_process";

/** Interval between resident-memory samples of one watched process group. */
export const DARWIN_MEMORY_SAMPLE_INTERVAL_MS = 100;

/** Sum the resident bytes `ps -A -o pgid=,rss=` reports for one process group. */
export const darwinGroupResidentBytes = (
  report: string,
  processGroupId: number,
): number =>
  report.split("\n").reduce((total, line) => {
    const [group, kibibytes] = line.trim().split(/\s+/u);
    return Number(group) === processGroupId && /^[0-9]+$/u.test(kibibytes ?? "")
      ? total + Number(kibibytes) * 1024
      : total;
  }, 0);

/**
 * Kill a macOS process group once its summed resident memory passes the limit.
 *
 * macOS accepts RLIMIT_AS but does not enforce it, so the bound is sampled
 * instead: a burst faster than one sample interval can overshoot before the
 * group is killed. The child reports the kill through `memoryLimitReached`,
 * the property the Windows Job Object launcher sets.
 */
export const watchDarwinProcessGroupMemory = (
  child: ChildProcess,
  processGroupId: number,
  limitBytes: number,
  sample: (
    callback: (report: string | undefined) => void,
  ) => void = sampleProcessTable,
): void => {
  let reached = false;
  let sampling = false;
  Object.defineProperty(child, "memoryLimitReached", {
    configurable: true,
    get: () => reached,
  });
  const timer = setInterval(() => {
    if (sampling || reached) return;
    sampling = true;
    sample((report) => {
      sampling = false;
      if (
        report === undefined ||
        reached ||
        darwinGroupResidentBytes(report, processGroupId) <= limitBytes
      )
        return;
      reached = true;
      try {
        process.kill(-processGroupId, "SIGKILL");
      } catch {
        // The group exited between the sample and the kill.
      }
    });
  }, DARWIN_MEMORY_SAMPLE_INTERVAL_MS);
  timer.unref();
  child.once("exit", () => clearInterval(timer));
};

const sampleProcessTable = (
  callback: (report: string | undefined) => void,
): void => {
  execFile(
    "/bin/ps",
    ["-A", "-o", "pgid=,rss="],
    { maxBuffer: 8 * 1024 * 1024, windowsHide: true },
    (error, stdout) => callback(error === null ? stdout : undefined),
  );
};
