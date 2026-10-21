import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { cleanupOwnedProcessGroup } from "../../process/ProcessOwnership.js";
import {
  boundedLaunch,
  describeHostResourceBound,
  prepareHostResourceBound,
} from "../../process/HostResourceBound.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
  type OwnedProviderProcessSpawnOptions,
  type SpawnedOwnedProviderProcess,
} from "../../process/ProviderProcess.js";
import {
  checkRecoveryDeadline,
  inventoryRecoveryFiles,
  fingerprintRecoveryFile,
  recoveryFailureMessage,
} from "./RecoveryFiles.js";
import { RECOVERY_LIMITS } from "./WakaruRelease.js";

const OPERATION = "recover_javascript_sources";
const WAKARU_REQUIREMENT =
  "Provide an absolute REA_WAKARU_COMMAND pointing to a Wakaru ^1.13.0 binary for this host (verified with 1.14.0); no tool is installed by REA. See docs/javascript-recovery.md#install-wakaru.";

/** Wakaru's ceilings, the fixed prlimit profile it had on Linux. */
const WAKARU_BOUND_LIMITS = {
  address_space_bytes: RECOVERY_LIMITS.addressSpaceBytes,
  file_bytes: RECOVERY_LIMITS.outputBytes,
  cpu_seconds: 120,
};

/** Inject the owned process launcher while retaining production protocol parsing. */
export type WakaruLauncher = (
  options: OwnedProviderProcessSpawnOptions,
) => Promise<SpawnedOwnedProviderProcess>;

/** Cleanup failure carrying the live supervisor so the provider can retry it. */
export class WakaruCleanupFailure extends ProviderCleanupError {
  constructor(
    readonly cleanupOwner: ProviderProcessSupervisor,
    readonly runId: string,
    readonly cwd: string,
    reason: string,
    previousError: unknown,
    snapshot: ReturnType<ProviderProcessSupervisor["snapshot"]>,
  ) {
    super(
      "wakaru",
      [runId, cwd],
      {
        reason,
        previous_error:
          previousError instanceof Error ? previousError.message : null,
        exit_code: snapshot.exitCode ?? null,
        signal: snapshot.signal ?? null,
      },
      { operation: OPERATION, cause: previousError },
    );
  }
}

/** Resolve and fingerprint explicitly configured tools; acquire nothing at startup. */
export const resolveWakaruCommand = async (
  environment: Readonly<Record<string, string | undefined>>,
) => {
  const configured = environment.REA_WAKARU_COMMAND;
  if (configured === undefined || !isAbsolute(configured))
    throw new AnalysisCapabilityUnavailableError(
      "wakaru",
      OPERATION,
      WAKARU_REQUIREMENT,
      { userMessage: WAKARU_REQUIREMENT },
    );
  try {
    const command = await realpath(configured);
    await access(command, constants.R_OK | constants.X_OK);
    const fingerprint = await fingerprintRecoveryFile(
      command,
      RECOVERY_LIMITS.outputBytes,
    );
    const limiter = (
      await prepareHostResourceBound({
        configured: WAKARU_BOUND_LIMITS,
        prlimitVariable: "REA_JAVASCRIPT_PRLIMIT_COMMAND",
        environment,
        readLimits: async (limits) => limits,
      })
    ).enforcer;
    if (!(await stat(limiter)).isFile())
      throw new TypeError(`Resource limiter is not a regular file: ${limiter}`);
    return { command, limiter, ...fingerprint };
  } catch (cause: unknown) {
    const reason = `Configured Wakaru or its resource limiter is unavailable: ${recoveryFailureMessage(cause)}`;
    throw new AnalysisCapabilityUnavailableError("wakaru", OPERATION, reason, {
      cause,
      userMessage: reason,
    });
  }
};

type WakaruCommandContext = {
  command: string;
  limiter: string;
  arguments: readonly string[];
  cwd: string;
  deadline: number;
  environment: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  launcher?: WakaruLauncher;
  staging?: string;
};

/** Run one bounded command and verify cleanup before consuming its output. */
export const runWakaruCommand = async (context: WakaruCommandContext) => {
  checkRecoveryDeadline(context.deadline, context.signal);
  const runId = `rea-wakaru-${randomUUID()}`;
  const bound = describeHostResourceBound(
    process.platform,
    context.limiter,
    WAKARU_BOUND_LIMITS,
  );
  const spawned = await (context.launcher ?? spawnOwnedProviderProcess)({
    ...boundedLaunch(bound, context.command, context.arguments),
    expectedCommand: null,
    runId,
    cwd: context.cwd,
    hostEnvironment: context.environment,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    env: { TMPDIR: context.cwd, RAYON_NUM_THREADS: "1", NO_COLOR: "1" },
  }).catch((cause: unknown) => {
    if (context.signal?.aborted === true)
      throw new AnalysisCancelledError(OPERATION);
    throw new ProviderAdapterError("wakaru", OPERATION, {
      cause,
      diagnostics: {
        reason: "Failed to launch configured Wakaru under its resource bound",
        command: context.command,
        detail: recoveryFailureMessage(cause),
      },
    });
  });
  let oversized = false;
  const supervisor = new ProviderProcessSupervisor(
    {
      ...spawned,
      ownsProcessLifetime: true,
      cleanup:
        spawned.cleanup ?? (() => cleanupOwnedProcessGroup(spawned.ownership)),
    },
    {
      onDiagnostic: (event) => {
        if (
          event.type === "output" &&
          event.totalBytes > RECOVERY_LIMITS.reportBytes
        )
          oversized = true;
      },
    },
  );
  let failure: unknown;
  try {
    while (!(await supervisor.waitForOutputClose(100))) {
      checkRecoveryDeadline(context.deadline, context.signal);
      if (oversized)
        throw new AnalysisOutputError(
          OPERATION,
          "Wakaru diagnostic stream exceeds 8 MiB",
        );
      if (context.staging !== undefined)
        await inventoryRecoveryFiles(context.staging, context.signal);
    }
    checkRecoveryDeadline(context.deadline, context.signal);
    if (oversized)
      throw new AnalysisOutputError(
        OPERATION,
        "Wakaru diagnostic stream exceeds 8 MiB",
      );
  } catch (cause: unknown) {
    failure = cause;
  }
  const stopped = await supervisor.stop();
  const snapshot = supervisor.snapshot();
  if (stopped.status === "incomplete")
    throw new WakaruCleanupFailure(
      supervisor,
      runId,
      context.cwd,
      stopped.reason,
      failure,
      snapshot,
    );
  if (failure !== undefined) throw failure;
  if (context.signal?.aborted === true)
    throw new AnalysisCancelledError(OPERATION);
  return {
    exit_code: snapshot.exitCode ?? null,
    signal: snapshot.signal ?? null,
    stdout: snapshot.stdout.text,
    stderr: snapshot.stderr.text,
    command: context.command,
    arguments: [...context.arguments],
    resource_limiter: context.limiter,
  };
};
