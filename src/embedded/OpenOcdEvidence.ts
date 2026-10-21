import { createEvidence, type Evidence } from "../domain/evidence.js";

export const OPENOCD_PROVIDER_IDENTITY = {
  id: "openocd",
  name: "OpenOCD",
  version: null,
} as const;

const PROVENANCE_LIMITATION =
  "Configuration provenance records the caller-selected configuration files and the roots they resolved inside; it does not establish which device is attached or what state unrestricted OpenOCD commands left it in.";

export interface OpenOcdCommandResult {
  readonly command: string;
  readonly reply: string;
  readonly output_truncated: boolean;
  readonly completion_status: "complete" | "unknown";
}

export const createOpenOcdCommandEvidence = (input: {
  readonly sessionId: string;
  readonly command: string;
  readonly result: OpenOcdCommandResult;
  readonly configFiles: readonly string[];
  readonly resolvedConfigFiles: readonly string[];
}): Evidence =>
  createEvidence(undefined, OPENOCD_PROVIDER_IDENTITY, {
    predicateType: "rea.debugger.command-observation",
    operation: "openocd_command",
    parameters: {
      session_id: input.sessionId,
      command: input.command,
      configuration_provenance: {
        caller_selected_files: [...input.configFiles],
        resolved_files: [...input.resolvedConfigFiles],
      },
    },
    result: { ...input.result },
    rawResult: { ...input.result },
    subjectUnavailableReason:
      "The attached device identity is not established by the OpenOCD session identifier.",
    limitations: [
      ...(input.result.completion_status === "unknown"
        ? [
            "OpenOCD did not answer within the command deadline; the target may still be acting on the command.",
          ]
        : []),
      ...(input.result.output_truncated
        ? ["The reply exceeded the retained size and was truncated."]
        : []),
      PROVENANCE_LIMITATION,
    ],
  });
