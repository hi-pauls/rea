import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { Logger } from "pino";

import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { OscilloscopeManager } from "../oscilloscope/OscilloscopeManager.js";
import {
  runWithExternalMutationAdmission,
  type ExternalMutationAdmission,
} from "./externalMutationAdmission.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import type { ToolResultDelivery } from "./toolResult.js";

export type OscilloscopeToolManager = Pick<
  OscilloscopeManager,
  "inspect" | "startSingle" | "status" | "stop" | "exportWaveform"
>;

/** Register Rohde & Schwarz oscilloscope operations on the existing REA MCP server. */
export const registerOscilloscopeTools = (
  server: McpServer,
  manager: OscilloscopeToolManager,
  logger: Logger,
  delivery: ToolResultDelivery,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  session?: ExternalMutationAdmission,
): void => {
  const inspect = toolContract("inspect_oscilloscope");
  const start = toolContract("start_oscilloscope_acquisition");
  const status = toolContract("oscilloscope_acquisition_status");
  const stop = toolContract("stop_oscilloscope_acquisition");
  const exportWaveform = toolContract("export_oscilloscope_waveform");
  server.registerTool(
    inspect.name,
    toolRegistrationOptions(inspect),
    async () =>
      delivery.toCallToolResult(
        await logToolExecution(logger, inspect.name, () => manager.inspect()),
        inspect,
      ),
  );
  server.registerTool(
    start.name,
    toolRegistrationOptions(start),
    async (_input, context: ServerContext) =>
      delivery.toCallToolResult(
        await runWithExternalMutationAdmission(
          session,
          start.name,
          context.mcpReq.signal,
          () =>
            logToolExecution(logger, start.name, () => manager.startSingle()),
          undefined,
        ),
        start,
      ),
  );
  server.registerTool(status.name, toolRegistrationOptions(status), async () =>
    delivery.toCallToolResult(
      await logToolExecution(logger, status.name, () => manager.status()),
      status,
    ),
  );
  server.registerTool(
    stop.name,
    toolRegistrationOptions(stop),
    async (_input, context: ServerContext) =>
      delivery.toCallToolResult(
        await runWithExternalMutationAdmission(
          session,
          stop.name,
          context.mcpReq.signal,
          () => logToolExecution(logger, stop.name, () => manager.stop()),
          undefined,
        ),
        stop,
      ),
  );
  server.registerTool(
    exportWaveform.name,
    toolRegistrationOptions(exportWaveform),
    async (input, context: ServerContext) => {
      const result = await runWithExternalMutationAdmission(
        session,
        exportWaveform.name,
        context.mcpReq.signal,
        () =>
          logToolExecution(logger, exportWaveform.name, () =>
            manager.exportWaveform({
              channel: input.channel,
              outputPath: input.output_path,
            }),
          ),
        (value) => value.evidence,
      );
      if (!result.ok) return delivery.toCallToolResult(result, exportWaveform);
      const recorded = recordEvidence?.(result.value.evidence);
      return delivery.toEvidenceToolResult(
        result.value.evidence,
        exportWaveform,
        recorded,
      );
    },
  );
};
