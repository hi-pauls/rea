import { access, realpath, stat } from "node:fs/promises";
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

// A directory passes the X_OK check, so the regular-file test is what refuses it.
const resolveExecutable = async (path: string, label: string) => {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute.`);
  const resolved = await realpath(path);
  await access(resolved, constants.X_OK);
  if (!(await stat(resolved)).isFile())
    throw new Error(`${label} is not an executable regular file: ${path}`);
  return resolved;
};

/** The resolved component that enforces a host's bound, before limits are read. */
export interface HostResourceEnforcer {
  readonly platform: NodeJS.Platform;
  readonly configuredEnforcer: string;
  readonly enforcer: string;
}

/**
 * Resolve the component that enforces the bound on this host, refusing hosts
 * where none exists. Effective limits are read separately, by
 * boundForHostEnforcer, so a provider can keep reading them after its own
 * configuration checks.
 */
export const resolveHostResourceEnforcer = async (
  request: Omit<HostResourceBoundRequest, "configured" | "readLimits">,
): Promise<HostResourceEnforcer> => {
  const platform = request.platform ?? process.platform;
  if (platform === "linux") {
    const configuredEnforcer =
      request.environment[request.prlimitVariable] ?? "/usr/bin/prlimit";
    return {
      platform,
      configuredEnforcer,
      enforcer: await resolveExecutable(
        configuredEnforcer,
        request.prlimitVariable,
      ),
    };
  }
  if (platform === "darwin")
    return {
      platform,
      configuredEnforcer: "/bin/sh",
      enforcer: await resolveExecutable("/bin/sh", "/bin/sh"),
    };
  if (platform === "win32") {
    const enforcer = windowsAddonPath();
    await access(enforcer, constants.R_OK);
    return { platform, configuredEnforcer: enforcer, enforcer };
  }
  throw new Error(
    `No resource bound can be enforced on ${platform}: REA supports Linux prlimit, macOS ulimit with a resident-memory watchdog, and Windows Job Objects.`,
  );
};

/**
 * Complete a resolved enforcer into the bound: Linux keeps stricter inherited
 * ceilings, which are read here, while the other hosts apply the configured
 * limits as they are.
 */
export const boundForHostEnforcer = async (
  resolved: HostResourceEnforcer,
  configured: LinuxResourceLimits,
  readLimits: HostResourceBoundRequest["readLimits"],
): Promise<HostResourceBound> =>
  describeHostResourceBound(
    resolved.platform,
    resolved.enforcer,
    resolved.platform === "linux" ? await readLimits(configured) : configured,
    resolved.configuredEnforcer,
  );

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
): Promise<HostResourceBound> =>
  boundForHostEnforcer(
    await resolveHostResourceEnforcer(request),
    request.configured,
    request.readLimits,
  );

/**
 * Build the bound for an enforcer already resolved by prepareHostResourceBound,
 * without touching the filesystem; for commands run after that resolution.
 */
export const describeHostResourceBound = (
  platform: NodeJS.Platform,
  enforcer: string,
  limits: LinuxResourceLimits,
  configuredEnforcer = enforcer,
): HostResourceBound => {
  if (platform === "darwin")
    return {
      mechanism: "darwin-ulimit-rss-watchdog",
      configuredEnforcer,
      enforcer,
      enforcerArguments: [
        "-c",
        DARWIN_LIMIT_SCRIPT,
        "rea-limit",
        String(limits.cpu_seconds),
        String(Math.floor(limits.file_bytes / 1024)),
      ],
      memoryLimitBytes: limits.address_space_bytes,
      limits,
      limitation: `macOS ulimit enforces ${limits.cpu_seconds} CPU seconds and ${limits.file_bytes} bytes per file with core dumps disabled; the process group is killed once its sampled resident memory passes ${limits.address_space_bytes} bytes, which a burst shorter than the sample interval can overshoot. These are not aggregate machine quotas.`,
    };
  if (platform === "win32")
    return {
      mechanism: "windows-job-object",
      configuredEnforcer,
      enforcer,
      enforcerArguments: [],
      memoryLimitBytes: limits.address_space_bytes,
      limits,
      limitation: `Each owned Windows tool tree has a ${limits.address_space_bytes}-byte Job Object committed-memory limit; CPU time and file size are not enforced on Windows. This is not a machine-wide quota.`,
    };
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
};

/**
 * Launch coordinates under the fixed prlimit profile the firmware and Wakaru
 * engines had on Linux: one value sets the soft and the hard limit together and
 * inherited ceilings are not consulted. The other hosts take their usual bound.
 */
export const fixedProfileLaunch = (
  {
    platform,
    enforcer,
    limits,
  }: {
    readonly platform: NodeJS.Platform;
    readonly enforcer: string;
    readonly limits: LinuxResourceLimits;
  },
  command: string,
  args: readonly string[],
): ReturnType<typeof boundedLaunch> =>
  platform === "linux"
    ? {
        command: enforcer,
        arguments: [
          `--as=${String(limits.address_space_bytes)}`,
          `--fsize=${String(limits.file_bytes)}`,
          "--core=0",
          `--cpu=${String(limits.cpu_seconds)}`,
          "--",
          command,
          ...args,
        ],
      }
    : boundedLaunch(
        describeHostResourceBound(platform, enforcer, limits),
        command,
        args,
      );

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
