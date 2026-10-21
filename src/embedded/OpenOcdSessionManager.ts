import { randomUUID } from "node:crypto";
import { delimiter, isAbsolute, normalize } from "node:path";

import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Evidence } from "../domain/evidence.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
  type OwnedProviderProcessSpawnOptions,
  type SpawnedOwnedProviderProcess,
} from "../process/ProviderProcess.js";
import {
  closeOwnedDebuggerSessions,
  stopOwnedDebuggerProcess,
  type OwnedDebuggerDetachResult,
} from "../process/ownedDebuggerSession.js";
import {
  openOcdArguments,
  resolveOpenOcdConfigFile,
} from "./OpenOcdConfiguration.js";
import {
  OPENOCD_PROVIDER_IDENTITY,
  createOpenOcdCommandEvidence,
  type OpenOcdCommandResult,
} from "./OpenOcdEvidence.js";
import { OpenOcdTclClient } from "./OpenOcdTclClient.js";

const STARTUP_TIMEOUT_MS = 20_000;
const COMMAND_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const CONNECT_ATTEMPT_TIMEOUT_MS = 500;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_REPLY_BYTES = 1024 * 1024;
const DEFAULT_MAX_SESSIONS = 4;
const DEFAULT_GDB_PORT = 3333;
const DEFAULT_TCL_PORT = 6666;

export { OPENOCD_PROVIDER_IDENTITY } from "./OpenOcdEvidence.js";

// The device behind the probe is not a host process, so OpenOCD never has an
// inferior for the owned-debugger stop path to detach.
const noHostInferior = async (): Promise<OwnedDebuggerDetachResult> => ({
  status: "no-inferior",
});

export interface OpenOcdSessionDescription {
  readonly session_id: string;
  readonly gdb_port: number | null;
  readonly tcl_port: number;
  readonly config_files: readonly string[];
}

interface OpenOcdSession {
  readonly id: string;
  readonly launched: SpawnedOwnedProviderProcess;
  readonly supervisor: ProviderProcessSupervisor;
  readonly client: OpenOcdTclClient;
  readonly description: OpenOcdSessionDescription;
  readonly resolvedConfigFiles: readonly string[];
  readonly detachInferior: () => Promise<OwnedDebuggerDetachResult>;
  exited: boolean;
  commandTail: Promise<void>;
  readonly cleanupFailures: Set<AnalysisError>;
}

export interface OpenOcdStartOptions {
  readonly configFiles: readonly string[];
  readonly gdbPort?: number;
  readonly tclPort?: number;
}

/** Owns OpenOCD processes and their TCL/RPC connections for embedded targets. */
export class OpenOcdSessionManager {
  readonly #sessions = new Map<string, OpenOcdSession>();
  readonly #command: string | undefined;
  readonly #scriptRoots: readonly string[];
  readonly #environment: NodeJS.ProcessEnv;
  readonly #startupTimeoutMs: number;
  readonly #commandTimeoutMs: number;
  readonly #maxSessions: number;
  readonly #spawnProcess: typeof spawnOwnedProviderProcess;
  #closing = false;

  constructor(
    options: {
      readonly environment?: Readonly<NodeJS.ProcessEnv>;
      readonly startupTimeoutMs?: number;
      readonly commandTimeoutMs?: number;
      readonly maxSessions?: number;
      readonly spawnProcess?: typeof spawnOwnedProviderProcess;
    } = {},
  ) {
    this.#environment = { ...(options.environment ?? process.env) };
    this.#command = this.#environment.REA_OPENOCD_COMMAND;
    this.#scriptRoots = (this.#environment.REA_OPENOCD_SCRIPT_ROOTS ?? "")
      .split(delimiter)
      .filter((root) => root.length > 0)
      .map((root) => normalize(root));
    this.#startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    this.#commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
    this.#maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.#spawnProcess = options.spawnProcess ?? spawnOwnedProviderProcess;
  }

  async start(
    options: OpenOcdStartOptions,
    signal?: AbortSignal,
  ): Promise<Result<OpenOcdSessionDescription, AnalysisError>> {
    if (this.#command === undefined || this.#scriptRoots.length === 0)
      return err(
        new AnalysisCapabilityUnavailableError(
          OPENOCD_PROVIDER_IDENTITY.id,
          "start_openocd_session",
          "OpenOCD is not configured; set REA_OPENOCD_COMMAND to the OpenOCD executable and REA_OPENOCD_SCRIPT_ROOTS to the absolute configuration roots.",
        ),
      );
    const relativeRoot = this.#scriptRoots.find((root) => !isAbsolute(root));
    if (relativeRoot !== undefined)
      return err(
        new AnalysisCapabilityUnavailableError(
          OPENOCD_PROVIDER_IDENTITY.id,
          "start_openocd_session",
          `REA_OPENOCD_SCRIPT_ROOTS contains the relative root ${relativeRoot}; every root must be absolute.`,
        ),
      );
    if (options.configFiles.length === 0)
      return err(
        new AnalysisInputError("start_openocd_session", undefined, [
          {
            path: ["config_files"],
            reason: "invalid_value",
            message:
              "At least one configuration file is required, such as an interface configuration and a target configuration.",
          },
        ]),
      );
    const resolved: string[] = [];
    for (const [index, candidate] of options.configFiles.entries()) {
      const outcome = resolveOpenOcdConfigFile(candidate, this.#scriptRoots);
      if (!("resolved" in outcome))
        return err(
          new AnalysisInputError("start_openocd_session", undefined, [
            {
              path: ["config_files", index],
              reason: "invalid_value",
              message: `The configuration file ${outcome.reason}.`,
            },
          ]),
        );
      resolved.push(outcome.resolved);
    }
    const ports = this.#selectPorts(options);
    if ("reason" in ports)
      return err(
        new AnalysisInputError("start_openocd_session", undefined, [
          {
            path: [ports.field],
            reason: "out_of_range",
            message: ports.reason,
          },
        ]),
      );
    if (this.#closing || signal?.aborted)
      return err(new AnalysisCancelledError("start_openocd_session"));
    if (this.#sessions.size >= this.#maxSessions)
      return err(
        new AnalysisResourceConstraintError(
          "start_openocd_session",
          "memory",
          "OpenOCD session capacity reached.",
          { max_sessions: this.#maxSessions },
        ),
      );
    return this.#startResolved(options, resolved, ports, signal);
  }

  #selectPorts(
    options: OpenOcdStartOptions,
  ):
    | { readonly gdbPort: number; readonly tclPort: number }
    | { readonly field: string; readonly reason: string } {
    const gdbPort = options.gdbPort ?? DEFAULT_GDB_PORT;
    const tclPort = options.tclPort ?? DEFAULT_TCL_PORT;
    // Port 0 disables OpenOCD's GDB server; the TCL port is REA's own channel
    // and cannot be disabled, so it must be a real port.
    if (!Number.isInteger(gdbPort) || gdbPort < 0 || gdbPort > 65535)
      return {
        field: "gdb_port",
        reason:
          "The GDB port must be 0 to disable it, or a port from 1 to 65535.",
      };
    if (!Number.isInteger(tclPort) || tclPort < 1 || tclPort > 65535)
      return {
        field: "tcl_port",
        reason: "The TCL port must be a port from 1 to 65535.",
      };
    if (gdbPort === tclPort)
      return {
        field: "gdb_port",
        reason: "The GDB port and the TCL port must differ.",
      };
    return { gdbPort, tclPort };
  }

  async #startResolved(
    options: OpenOcdStartOptions,
    resolvedConfigFiles: readonly string[],
    ports: { readonly gdbPort: number; readonly tclPort: number },
    signal?: AbortSignal,
  ): Promise<Result<OpenOcdSessionDescription, AnalysisError>> {
    const id = randomUUID();
    let launched: SpawnedOwnedProviderProcess;
    const spawnOptions: OwnedProviderProcessSpawnOptions = {
      command: this.#command ?? "",
      arguments: openOcdArguments(
        this.#scriptRoots,
        resolvedConfigFiles,
        ports,
      ),
      runId: randomUUID(),
      stdin: "pipe",
      hostEnvironment: this.#environment,
      ...(signal === undefined ? {} : { signal }),
    };
    try {
      launched = await this.#spawnProcess(spawnOptions);
    } catch (cause) {
      if (signal?.aborted || cause instanceof AnalysisCancelledError)
        return err(
          new AnalysisCancelledError("start_openocd_session", { cause }),
        );
      return err(
        new AnalysisCapabilityUnavailableError(
          OPENOCD_PROVIDER_IDENTITY.id,
          "start_openocd_session",
          cause instanceof Error ? cause.message : "Unable to start OpenOCD",
        ),
      );
    }
    const supervisor = new ProviderProcessSupervisor(
      { process: launched.process, ownsProcessLifetime: false },
      { captureStdout: true, maxDiagnosticBytes: MAX_DIAGNOSTIC_BYTES },
    );
    let exited = false;
    launched.process.once("exit", () => {
      exited = true;
    });
    const client = await this.#connectWhileAlive(
      ports.tclPort,
      () => exited,
      signal,
    );
    if (!("client" in client)) {
      const stopped = await stopOwnedDebuggerProcess(
        {
          id,
          get exited() {
            return exited;
          },
          launched,
          supervisor,
          detachInferior: noHostInferior,
        },
        "OpenOCD",
      );
      const diagnostics =
        supervisor.snapshot().stderr.text.trim() || "no diagnostics";
      return err(
        new AnalysisCapabilityUnavailableError(
          OPENOCD_PROVIDER_IDENTITY.id,
          "start_openocd_session",
          `${client.reason} OpenOCD reported: ${diagnostics}`,
          stopped.status === "incomplete"
            ? { cleanup: { reason: stopped.reason, resources: [id] } }
            : {},
        ),
      );
    }
    const session: OpenOcdSession = {
      id,
      launched,
      supervisor,
      client: client.client,
      description: {
        session_id: id,
        gdb_port: ports.gdbPort === 0 ? null : ports.gdbPort,
        tcl_port: ports.tclPort,
        config_files: [...options.configFiles],
      },
      resolvedConfigFiles,
      exited,
      detachInferior: noHostInferior,
      commandTail: Promise.resolve(),
      cleanupFailures: new Set(),
    };
    launched.process.once("exit", () => {
      session.exited = true;
    });
    this.#sessions.set(id, session);
    return ok(session.description);
  }

  /**
   * Retries the connection until OpenOCD accepts one, and gives up as soon as
   * the process is gone, so a failed configuration surfaces as its own
   * diagnostics rather than as a connection deadline.
   */
  async #connectWhileAlive(
    tclPort: number,
    hasExited: () => boolean,
    signal?: AbortSignal,
  ): Promise<
    { readonly client: OpenOcdTclClient } | { readonly reason: string }
  > {
    const deadline = Date.now() + this.#startupTimeoutMs;
    let lastReason = "OpenOCD did not open its TCL port.";
    while (Date.now() < deadline) {
      if (signal?.aborted) return { reason: "The start was cancelled." };
      if (hasExited())
        return { reason: "OpenOCD exited before opening its TCL port." };
      try {
        const client = await OpenOcdTclClient.connect({
          port: tclPort,
          timeoutMs: CONNECT_ATTEMPT_TIMEOUT_MS,
          replyLimitBytes: MAX_REPLY_BYTES,
        });
        // A connection alone does not prove OpenOCD is answering commands.
        const version = await client.send("capture version", 2_000);
        if (version.text.includes("Open On-Chip Debugger")) return { client };
        client.close();
        lastReason = "OpenOCD did not identify itself on the TCL port.";
      } catch (cause) {
        lastReason = cause instanceof Error ? cause.message : String(cause);
      }
      // Not unref'd: once OpenOCD has exited this timer may be the only thing
      // keeping the event loop, and with it this start, alive.
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    return { reason: lastReason };
  }

  async execute(
    sessionId: string,
    command: string,
  ): Promise<Result<{ readonly evidence: Evidence }, AnalysisError>> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined)
      return err(
        new AnalysisInputError("openocd_command", undefined, [
          {
            path: ["session_id"],
            reason: "invalid_value",
            message: "No OpenOCD session has this identifier.",
          },
        ]),
      );
    if (session.exited)
      return err(
        new AnalysisCapabilityUnavailableError(
          OPENOCD_PROVIDER_IDENTITY.id,
          "openocd_command",
          "The owned OpenOCD process has exited.",
        ),
      );
    // Commands are serialized because the TCL protocol carries no request ids.
    const run = session.commandTail.then(async () => {
      let result: OpenOcdCommandResult;
      try {
        const reply = await session.client.send(
          command,
          this.#commandTimeoutMs,
        );
        result = {
          command,
          reply: reply.text,
          output_truncated: reply.truncated,
          completion_status: "complete",
        };
      } catch (cause) {
        result = {
          command,
          reply: cause instanceof Error ? cause.message : String(cause),
          output_truncated: false,
          completion_status: "unknown",
        };
      }
      return result;
    });
    session.commandTail = run.then(
      () => undefined,
      () => undefined,
    );
    const result = await run;
    return ok({
      evidence: createOpenOcdCommandEvidence({
        sessionId,
        command,
        result,
        configFiles: session.description.config_files,
        resolvedConfigFiles: session.resolvedConfigFiles,
      }),
    });
  }

  status(sessionId: string): Result<
    {
      readonly session_id: string;
      readonly state: "ready" | "closed";
      readonly gdb_port: number | null;
      readonly tcl_port: number;
      readonly config_files: readonly string[];
      readonly stderr: string;
      readonly stderr_truncated: boolean;
    },
    AnalysisError
  > {
    const session = this.#sessions.get(sessionId);
    if (session === undefined)
      return err(
        new AnalysisInputError("openocd_session_status", undefined, [
          {
            path: ["session_id"],
            reason: "invalid_value",
            message: "No OpenOCD session has this identifier.",
          },
        ]),
      );
    const snapshot = session.supervisor.snapshot();
    return ok({
      session_id: sessionId,
      state: session.exited ? "closed" : "ready",
      gdb_port: session.description.gdb_port,
      tcl_port: session.description.tcl_port,
      config_files: session.description.config_files,
      stderr: snapshot.stderr.text,
      stderr_truncated: snapshot.stderr.observedBytes > snapshot.stderr.bytes,
    });
  }

  async close(
    sessionId: string,
  ): Promise<Result<{ readonly target_state: "unknown" }, AnalysisError>> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined)
      return err(
        new AnalysisInputError("close_openocd_session", undefined, [
          {
            path: ["session_id"],
            reason: "invalid_value",
            message: "No OpenOCD session has this identifier.",
          },
        ]),
      );
    // OpenOCD's shutdown leaves the attached device in whatever state the
    // session left it; REA neither resets nor halts it as part of cleanup.
    if (!session.exited)
      try {
        await session.client.send("shutdown", SHUTDOWN_TIMEOUT_MS);
      } catch {
        // An unanswered shutdown is expected when OpenOCD closes the
        // connection as it exits; the owned process stop below is decisive.
      }
    session.client.close();
    const stopped = await stopOwnedDebuggerProcess(session, "OpenOCD");
    if (stopped.status === "incomplete") {
      const failure = new AnalysisCapabilityUnavailableError(
        OPENOCD_PROVIDER_IDENTITY.id,
        "close_openocd_session",
        `The owned OpenOCD process could not be confirmed stopped: ${stopped.reason}`,
        { cleanup: { reason: stopped.reason, resources: [session.id] } },
      );
      session.cleanupFailures.add(failure);
      return err(failure);
    }
    this.#sessions.delete(sessionId);
    return ok({ target_state: "unknown" });
  }

  async closeAll(): Promise<void> {
    this.#closing = true;
    await closeOwnedDebuggerSessions(
      this.#sessions,
      async (session) => {
        session.client.close();
        return stopOwnedDebuggerProcess(session, "OpenOCD");
      },
      "OpenOCD",
    );
  }

  async retryCleanupFailures(): Promise<Result<null, AnalysisError>> {
    for (const session of this.#sessions.values()) {
      if (session.cleanupFailures.size === 0) continue;
      const stopped = await stopOwnedDebuggerProcess(session, "OpenOCD");
      if (stopped.status === "incomplete")
        return err(
          [...session.cleanupFailures].at(-1) ??
            new AnalysisCapabilityUnavailableError(
              OPENOCD_PROVIDER_IDENTITY.id,
              "close_openocd_session",
              stopped.reason,
            ),
        );
      this.#sessions.delete(session.id);
    }
    return ok(null);
  }
}
