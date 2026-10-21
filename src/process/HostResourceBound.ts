import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";

import type { resourceLimiterSchema } from "../domain/resourceLimiter.js";
import type { LinuxResourceLimits } from "./LinuxResourceLimits.js";

/** How one producer's resource ceilings are enforced on this host. */
export type HostResourceMechanism = z.infer<
  typeof resourceLimiterSchema
>["mechanism"];

/** Ceilings for one producer launch and the component that enforces them. */
export interface HostResourceBound {
  readonly mechanism: HostResourceMechanism;
  /** Configured enforcer path as given, before resolution. */
  readonly configuredEnforcer: string;
  /** Resolved enforcer executable or addon; providers hash it before and after use. */
  readonly enforcer: string;
  /** Arguments placed between the enforcer and the producer argv; empty for Windows. */
  readonly enforcerArguments: readonly string[];
  /** Memory limit the owned-process launcher enforces itself, where prlimit is absent. */
  readonly memoryLimitBytes?: number;
  readonly limits: LinuxResourceLimits;
  readonly limitation: string;
}

/** Inputs that differ per producer family. */
export interface HostResourceBoundRequest {
  readonly configured: LinuxResourceLimits;
  /** Linux limiter variable, e.g. REA_SIGROK_PRLIMIT_COMMAND. */
  readonly prlimitVariable: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly readLimits: (
    configured: LinuxResourceLimits,
  ) => Promise<LinuxResourceLimits>;
  readonly platform?: NodeJS.Platform;
}

// macOS /bin/sh counts `ulimit -f` in 1024-byte blocks; core dumps stay off as with prlimit.
const DARWIN_LIMIT_SCRIPT =
  'ulimit -t "$1" && ulimit -f "$2" && ulimit -c 0 && shift 2 && exec "$@"';

const windowsAddonPath = (): string =>
  fileURLToPath(
    new URL("../../native/windows/build/rea-windows-x64.node", import.meta.url),
  );

const resolveExecutable = async (path: string, label: string) => {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute.`);
  const resolved = await realpath(path);
  await access(resolved, constants.X_OK);
  return resolved;
};

/**
 * Establish the bound one producer runs under.
 *
 * Linux keeps prlimit with stricter inherited ceilings. macOS limits CPU time
 * and file size through `ulimit` and memory through the launcher's resident
 * memory watchdog. Windows limits committed memory through the owned Job
 * Object; CPU time and file size are not enforced there.
 */
export const prepareHostResourceBound = async (
  request: HostResourceBoundRequest,
): Promise<HostResourceBound> => {
  const platform = request.platform ?? process.platform;
  const { configured } = request;
  if (platform === "linux") {
    const configuredEnforcer =
      request.environment[request.prlimitVariable] ?? "/usr/bin/prlimit";
    const enforcer = await resolveExecutable(
      configuredEnforcer,
      request.prlimitVariable,
    );
    const limits = await request.readLimits(configured);
    return {
      mechanism: "prlimit",
      configuredEnforcer,
      enforcer,
      enforcerArguments: [
        `--as=${limits.address_space_bytes}:${limits.address_space_bytes}`,
        `--fsize=${limits.file_bytes}:${limits.file_bytes}`,
        `--cpu=${limits.cpu_seconds}:${limits.cpu_seconds}`,
        "--core=0:0",
        "--",
      ],
      limits,
      limitation: `Linux prlimit preserves stricter inherited ceilings: ${limits.address_space_bytes} bytes of per-process address space, ${limits.file_bytes} bytes per file and ${limits.cpu_seconds} CPU seconds; core dumps are disabled. These are not aggregate machine quotas.`,
    };
  }
  if (platform === "darwin") {
    const enforcer = await resolveExecutable("/bin/sh", "/bin/sh");
    return {
      mechanism: "darwin-ulimit-rss-watchdog",
      configuredEnforcer: "/bin/sh",
      enforcer,
      enforcerArguments: [
        "-c",
        DARWIN_LIMIT_SCRIPT,
        "rea-limit",
        String(configured.cpu_seconds),
        String(Math.floor(configured.file_bytes / 1024)),
      ],
      memoryLimitBytes: configured.address_space_bytes,
      limits: configured,
      limitation: `macOS ulimit enforces ${configured.cpu_seconds} CPU seconds and ${configured.file_bytes} bytes per file with core dumps disabled; the process group is killed once its sampled resident memory passes ${configured.address_space_bytes} bytes, which a burst shorter than the sample interval can overshoot. These are not aggregate machine quotas.`,
    };
  }
  if (platform === "win32") {
    const enforcer = windowsAddonPath();
    await access(enforcer, constants.R_OK);
    return {
      mechanism: "windows-job-object",
      configuredEnforcer: enforcer,
      enforcer,
      enforcerArguments: [],
      memoryLimitBytes: configured.address_space_bytes,
      limits: configured,
      limitation: `Each owned Windows tool tree has a ${configured.address_space_bytes}-byte Job Object committed-memory limit; CPU time and file size are not enforced on Windows. This is not a machine-wide quota.`,
    };
  }
  throw new Error(
    `No resource bound can be enforced on ${platform}: REA supports Linux prlimit, macOS ulimit with a resident-memory watchdog, and Windows Job Objects.`,
  );
};

/** Launch coordinates for a producer under its bound. */
export const boundedLaunch = (
  bound: HostResourceBound,
  command: string,
  args: readonly string[],
): {
  readonly command: string;
  readonly arguments: string[];
  readonly memoryLimitBytes?: number;
} =>
  bound.mechanism === "windows-job-object"
    ? {
        command,
        arguments: [...args],
        ...(bound.memoryLimitBytes === undefined
          ? {}
          : { memoryLimitBytes: bound.memoryLimitBytes }),
      }
    : {
        command: bound.enforcer,
        arguments: [...bound.enforcerArguments, command, ...args],
        ...(bound.memoryLimitBytes === undefined
          ? {}
          : { memoryLimitBytes: bound.memoryLimitBytes }),
      };
