import { z } from "zod";

import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";

const SUPPLY_REQUIREMENT =
  "REA connects to a Rigol DP800 power supply such as the DP832 over SCPI at REA_POWER_SUPPLY_HOST:REA_POWER_SUPPLY_PORT (port default 5555); the instrument must be reachable on the network.";

const channelState = z.strictObject({
  channel: z.number().int(),
  rated_volts: z.number(),
  rated_amps: z.number(),
  voltage_setpoint: z.number(),
  current_limit: z.number(),
  output_on: z.boolean(),
  mode: z
    .string()
    .describe(
      "CV (constant voltage), CC (constant current) or UR (unregulated).",
    ),
  measured_volts: z.number(),
  measured_amps: z.number(),
  measured_watts: z.number(),
  over_voltage_protection: z.strictObject({
    enabled: z.boolean(),
    volts: z.number(),
  }),
  over_current_protection: z.strictObject({
    enabled: z.boolean(),
    amps: z.number(),
  }),
});

const channelInput = z
  .number()
  .int()
  .min(1)
  .max(3)
  .describe("Output channel, 1 to 3 on a DP832.");

/** Rigol DP800 bench power supply contracts over the instrument's SCPI socket. */
export const POWER_SUPPLY_TOOL_CONTRACTS = [
  {
    name: "inspect_power_supply",
    ...toolContractMetadata("inspect_power_supply"),
    kind: "native-provider",
    description: `Report the power supply's identity and, per channel, its rating, voltage setpoint, current limit, output state, regulation mode, measured voltage, current and power, and over-voltage and over-current protection, without changing any setting. ${SUPPLY_REQUIREMENT}`,
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({
      identity: z.strictObject({
        manufacturer: z.string(),
        model: z.string(),
        serial: z.string(),
        firmware: z.string(),
      }),
      channels: z.array(channelState),
    }),
    examples: [{ title: "Inspect the power supply", input: {} }],
  },
  {
    name: "configure_power_supply_channel",
    ...toolContractMetadata("configure_power_supply_channel"),
    kind: "native-provider",
    description: `Set a channel's voltage, current limit, and over-voltage or over-current protection level; a protection level given is also switched on. Settings left out keep their values. Voltage and current are refused outside the channel's rating. The output state is not changed, but on an enabled output the new setting reaches the connected device at once. Returns the channel's state afterwards. ${SUPPLY_REQUIREMENT}`,
    inputSchema: z.strictObject({
      channel: channelInput,
      voltage: z
        .number()
        .min(0)
        .optional()
        .describe("Voltage setpoint in volts."),
      current_limit: z
        .number()
        .min(0)
        .optional()
        .describe("Current limit in amperes."),
      over_voltage_protection: z
        .number()
        .min(0)
        .optional()
        .describe(
          "Over-voltage protection level in volts; switches the protection on.",
        ),
      over_current_protection: z
        .number()
        .min(0)
        .optional()
        .describe(
          "Over-current protection level in amperes; switches the protection on.",
        ),
    }),
    outputSchema: channelState,
    examples: [
      {
        title: "3.3 V at 200 mA with protection",
        input: {
          channel: 3,
          voltage: 3.3,
          current_limit: 0.2,
          over_voltage_protection: 3.6,
          over_current_protection: 0.25,
        },
      },
    ],
  },
  {
    name: "set_power_supply_output",
    ...toolContractMetadata("set_power_supply_output"),
    kind: "native-provider",
    description: `Switch a channel's output on or off, powering or cutting the connected device, and return the channel's state with its measurement once the output settled. Fails if the output does not read the requested state afterwards, as when a protection trips. Check the setpoints with inspect_power_supply before switching on. ${SUPPLY_REQUIREMENT}`,
    inputSchema: z.strictObject({
      channel: channelInput,
      on: z.boolean().describe("true switches the output on, false off."),
    }),
    outputSchema: channelState,
    examples: [{ title: "Power channel 1", input: { channel: 1, on: true } }],
  },
] as const satisfies readonly ToolContract[];
