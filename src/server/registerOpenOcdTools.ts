import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { Logger } from "pino";

import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { OpenOcdSessionManager } from "../embedded/OpenOcdSessionManager.js";
import {
  runOwnedCleanupWithExternalMutationAdmission,
  runWithExternalMutationAdmission,
  type ExternalMutationAdmission,
} from "./externalMutationAdmission.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import type { ToolResultDelivery } from "./toolResult.js";

export type OpenOcdToolManager = Pick<
  OpenOcdSessionManager,
  "start" | "execute" | "status" | "close" | "retryCleanupFailures"
>;

/** Register OpenOCD session operations on the existing REA MCP server. */
export const registerOpenOcdTools = (
  server: McpServer,
  manager: OpenOcdToolManager,
  logger: Logger,
  delivery: ToolResultDelivery,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  session?: ExternalMutationAdmission,
): void => {
  const start = toolContract("start_openocd_session");
  const command = toolContract("openocd_command");
  const status = toolContract("openocd_session_status");
  const close = toolContract("close_openocd_session");
  server.registerTool(
    start.name,
    toolRegistrationOptions(start),
    async (input, context: ServerContext) => {
      const result = await runWithExternalMutationAdmission(
        session,
        start.name,
        context.mcpReq.signal,
        () =>
          logToolExecution(logger, start.name, () =>
            manager.start(
              {
                configFiles: input.config_files,
                ...(input.gdb_port === undefined
                  ? {}
                  : { gdbPort: input.gdb_port }),
                ...(input.tcl_port === undefined
                  ? {}
                  : { tclPort: input.tcl_port }),
              },
              context.mcpReq.signal,
            ),
          ),
        undefined,
        () => manager.retryCleanupFailures(),
      );
      return delivery.toCallToolResult(
        result.ok
          ? {
              ok: true,
              value: {
                ...result.value,
                config_files: [...result.value.config_files],
              },
            }
          : result,
        start,
      );
    },
  );
  server.registerTool(
    command.name,
    toolRegistrationOptions(command),
    async (input, context: ServerContext) => {
      const result = await runWithExternalMutationAdmission(
        session,
        command.name,
        context.mcpReq.signal,
        () =>
          logToolExecution(logger, command.name, () =>
            manager.execute(input.session_id, input.command),
          ),
        (value) => value.evidence,
        () => manager.retryCleanupFailures(),
      );
      if (!result.ok) return delivery.toCallToolResult(result, command);
      const recorded = recordEvidence?.(result.value.evidence);
      return delivery.toEvidenceToolResult(
        result.value.evidence,
        command,
        recorded,
      );
    },
  );
  server.registerTool(
    status.name,
    toolRegistrationOptions(status),
    async (input) => {
      const result = manager.status(input.session_id);
      return delivery.toCallToolResult(
        result.ok
          ? {
              ok: true,
              value: {
                ...result.value,
                config_files: [...result.value.config_files],
              },
            }
          : result,
        status,
      );
    },
  );
  server.registerTool(
    close.name,
    toolRegistrationOptions(close),
    async (input, context: ServerContext) => {
      const result = await runOwnedCleanupWithExternalMutationAdmission(
        session,
        close.name,
        context.mcpReq.signal,
        input.session_id,
        () =>
          logToolExecution(logger, close.name, () =>
            manager.close(input.session_id),
          ),
      );
      return delivery.toCallToolResult(result, close);
    },
  );
};
