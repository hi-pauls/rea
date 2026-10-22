import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { Logger } from "pino";

import { toolContract } from "../contracts/toolContracts.js";
import type { PowerSupplyManager } from "../power/PowerSupplyManager.js";
import {
  runWithExternalMutationAdmission,
  type ExternalMutationAdmission,
} from "./externalMutationAdmission.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import type { ToolResultDelivery } from "./toolResult.js";

export type PowerSupplyToolManager = Pick<
  PowerSupplyManager,
  "inspect" | "configure" | "setOutput"
>;

/** Register Rigol DP800 power supply operations on the existing REA MCP server. */
export const registerPowerSupplyTools = (
  server: McpServer,
  manager: PowerSupplyToolManager,
  logger: Logger,
  delivery: ToolResultDelivery,
  session?: ExternalMutationAdmission,
): void => {
  const inspect = toolContract("inspect_power_supply");
  const configure = toolContract("configure_power_supply_channel");
  const output = toolContract("set_power_supply_output");
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
    configure.name,
    toolRegistrationOptions(configure),
    async (input, context: ServerContext) =>
      delivery.toCallToolResult(
        await runWithExternalMutationAdmission(
          session,
          configure.name,
          context.mcpReq.signal,
          () =>
            logToolExecution(logger, configure.name, () =>
              manager.configure({
                channel: input.channel,
                voltage: input.voltage,
                currentLimit: input.current_limit,
                overVoltageProtection: input.over_voltage_protection,
                overCurrentProtection: input.over_current_protection,
              }),
            ),
          undefined,
        ),
        configure,
      ),
  );
  server.registerTool(
    output.name,
    toolRegistrationOptions(output),
    async (input, context: ServerContext) =>
      delivery.toCallToolResult(
        await runWithExternalMutationAdmission(
          session,
          output.name,
          context.mcpReq.signal,
          () =>
            logToolExecution(logger, output.name, () =>
              manager.setOutput({ channel: input.channel, on: input.on }),
            ),
          undefined,
        ),
        output,
      ),
  );
};
