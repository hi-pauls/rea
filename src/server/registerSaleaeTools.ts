import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { Logger } from "pino";

import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { SaleaeLogicManager } from "../saleae/SaleaeLogicManager.js";
import {
  runWithExternalMutationAdmission,
  type ExternalMutationAdmission,
} from "./externalMutationAdmission.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import type { ToolResultDelivery } from "./toolResult.js";

export type SaleaeToolManager = Pick<
  SaleaeLogicManager,
  "inspect" | "startCapture" | "status" | "stopCapture" | "export"
>;

/** Register Saleae Logic 1.x operations on the existing REA MCP server. */
export const registerSaleaeTools = (
  server: McpServer,
  manager: SaleaeToolManager,
  logger: Logger,
  delivery: ToolResultDelivery,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  session?: ExternalMutationAdmission,
): void => {
  const inspect = toolContract("inspect_saleae_logic");
  const start = toolContract("start_saleae_capture");
  const status = toolContract("saleae_capture_status");
  const stop = toolContract("stop_saleae_capture");
  const exportCapture = toolContract("export_saleae_capture");
  server.registerTool(
    inspect.name,
    toolRegistrationOptions(inspect),
    async () => {
      const result = await logToolExecution(logger, inspect.name, () =>
        manager.inspect(),
      );
      return delivery.toCallToolResult(
        result.ok
          ? {
              ok: true,
              value: {
                devices: result.value.devices.map((device) => ({ ...device })),
                active_channels:
                  result.value.active_channels === null
                    ? null
                    : {
                        digital: [...result.value.active_channels.digital],
                        analog: [...result.value.active_channels.analog],
                      },
                processing_complete: result.value.processing_complete,
              },
            }
          : result,
        inspect,
      );
    },
  );
  server.registerTool(
    start.name,
    toolRegistrationOptions(start),
    async (input, context: ServerContext) =>
      delivery.toCallToolResult(
        await runWithExternalMutationAdmission(
          session,
          start.name,
          context.mcpReq.signal,
          () =>
            logToolExecution(logger, start.name, () =>
              manager.startCapture({ focus: input.focus ?? false }),
            ),
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
          () =>
            logToolExecution(logger, stop.name, () => manager.stopCapture()),
          undefined,
        ),
        stop,
      ),
  );
  server.registerTool(
    exportCapture.name,
    toolRegistrationOptions(exportCapture),
    async (input, context: ServerContext) => {
      const result = await runWithExternalMutationAdmission(
        session,
        exportCapture.name,
        context.mcpReq.signal,
        () =>
          logToolExecution(logger, exportCapture.name, () =>
            manager.export({
              outputPath: input.output_path,
              format: input.format ?? "vcd",
            }),
          ),
        (value) => value.evidence,
      );
      if (!result.ok) return delivery.toCallToolResult(result, exportCapture);
      const recorded = recordEvidence?.(result.value.evidence);
      return delivery.toEvidenceToolResult(
        result.value.evidence,
        exportCapture,
        recorded,
      );
    },
  );
};
