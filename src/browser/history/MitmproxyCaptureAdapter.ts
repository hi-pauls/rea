import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { AnalysisCapabilityUnavailableError } from "../../domain/analysisErrorCore.js";
import type { HistoricalCaptureFormatAdapter } from "./HistoricalCaptureFormatAdapter.js";
import { MITMPROXY_CAPTURE_PROVIDER_IDENTITY } from "./CaptureRelease.js";
const OPERATION = "inspect_web_network_capture";
const MITMDUMP_REQUIREMENT =
  "Native capture decoding requires an absolute REA_MITMDUMP_COMMAND path to caller-supplied mitmdump 12.2.3; HAR needs no external engine.";
// The bridge lowers RLIMIT_AS itself where rlimits exist; Windows and macOS bound the tree here.
const DECODER_MEMORY_LIMIT_BYTES = 768 * 1024 * 1024;

/** Native mitmproxy decoding is offline and uses only an explicitly configured tool. */
export class MitmproxyCaptureAdapter implements HistoricalCaptureFormatAdapter {
  readonly format = "mitmproxy";
  readonly identity = MITMPROXY_CAPTURE_PROVIDER_IDENTITY;
  constructor(readonly environment: Readonly<NodeJS.ProcessEnv>) {}
  async command(
    requestPath: string,
    runtimePath: string,
  ): Promise<{
    command: string;
    arguments: readonly string[];
    memoryLimitBytes?: number;
  }> {
    const command = this.environment.REA_MITMDUMP_COMMAND;
    if (command === undefined || !isAbsolute(command))
      throw new AnalysisCapabilityUnavailableError(
        "mitmproxy",
        OPERATION,
        MITMDUMP_REQUIREMENT,
        { userMessage: MITMDUMP_REQUIREMENT },
      );
    try {
      await access(command, constants.R_OK | constants.X_OK);
      if (!(await stat(command)).isFile())
        throw new TypeError("Configured path is not a regular file");
    } catch (cause: unknown) {
      const reason = `Configured mitmdump executable is unavailable: ${command}.`;
      throw new AnalysisCapabilityUnavailableError(
        "mitmproxy",
        OPERATION,
        reason,
        { cause, userMessage: reason },
      );
    }
    return {
      command,
      arguments: [
        "--no-server",
        "-q",
        "--set",
        `confdir=${runtimePath}`,
        "--set",
        `rea_request_path=${requestPath}`,
        "-s",
        fileURLToPath(
          new URL("../../../bridge/mitmproxy/capture.py", import.meta.url),
        ),
      ],
      ...(process.platform === "linux"
        ? {}
        : { memoryLimitBytes: DECODER_MEMORY_LIMIT_BYTES }),
    };
  }
}
