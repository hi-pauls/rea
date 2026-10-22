import { z } from "zod";

import { localPathStringSchema } from "../domain/localPath.js";
import type { ToolContract } from "./toolContractTypes.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "./toolEffects.js";

const SCOPE_REQUIREMENT =
  "REA connects to a Rohde & Schwarz oscilloscope such as the RTB2004 over SCPI at REA_OSCILLOSCOPE_HOST:REA_OSCILLOSCOPE_PORT (port default 5025); the instrument must be reachable on the network.";

const acquisitionState = z
  .string()
  .describe(
    "ACQuire:STATe? as reported: RUN, STOP, COMP (complete) or BRE (break).",
  );

const exportResult = z.strictObject({
  path: z.string(),
  channel: z.number().int(),
  points: z.number().int().nonnegative(),
  values_per_sample: z.number().int(),
  x_start_s: z.number(),
  x_stop_s: z.number(),
  acquisition_state: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
});

/** Rohde & Schwarz oscilloscope contracts over the instrument's SCPI socket. */
export const OSCILLOSCOPE_TOOL_CONTRACTS = [
  {
    name: "inspect_oscilloscope",
    ...toolContractMetadata("inspect_oscilloscope"),
    kind: "native-provider",
    description: `Report the oscilloscope's identity, each analog channel's state and vertical scale, the timebase, sample rate, acquisition state and trigger mode, without changing any setting. ${SCOPE_REQUIREMENT}`,
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({
      identity: z.strictObject({
        manufacturer: z.string(),
        model: z.string(),
        serial: z.string(),
        firmware: z.string(),
      }),
      channels: z.array(
        z.strictObject({
          channel: z.number().int(),
          enabled: z.boolean(),
          volts_per_division: z.number(),
        }),
      ),
      seconds_per_division: z.number(),
      sample_rate_hz: z.number(),
      acquisition_state: acquisitionState,
      trigger_mode: z.string(),
    }),
    examples: [{ title: "Inspect the oscilloscope", input: {} }],
  },
  {
    name: "start_oscilloscope_acquisition",
    ...toolContractMetadata("start_oscilloscope_acquisition"),
    kind: "native-provider",
    description: `Arm one single acquisition with the trigger and settings configured on the instrument, and return at once; the instrument leaves continuous acquisition and waits for its trigger, so arm it before the event. Check oscilloscope_acquisition_status, then export_oscilloscope_waveform. ${SCOPE_REQUIREMENT}`,
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({
      armed: z.literal(true),
      acquisition_state: acquisitionState,
    }),
    examples: [{ title: "Arm a single acquisition", input: {} }],
  },
  {
    name: "oscilloscope_acquisition_status",
    ...toolContractMetadata("oscilloscope_acquisition_status"),
    kind: "native-provider",
    description: `Report the acquisition state; complete is false while the instrument still acquires or waits for its trigger. ${SCOPE_REQUIREMENT}`,
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({
      acquisition_state: acquisitionState,
      complete: z.boolean(),
    }),
    examples: [{ title: "Check the acquisition", input: {} }],
  },
  {
    name: "stop_oscilloscope_acquisition",
    ...toolContractMetadata("stop_oscilloscope_acquisition"),
    kind: "native-provider",
    description: `Stop the acquisition in progress, keeping the last waveform on the instrument. ${SCOPE_REQUIREMENT}`,
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({ acquisition_state: acquisitionState }),
    examples: [{ title: "Stop the acquisition", input: {} }],
  },
  {
    name: "export_oscilloscope_waveform",
    ...toolContractMetadata("export_oscilloscope_waveform"),
    kind: "native-provider",
    description: `Read one enabled analog channel's waveform from the instrument and write it as CSV to output_path on REA's own host, with a time_s column and a volts column (volts_min and volts_max for peak detect), and return its size and SHA-256 with Evidence. The waveform is what the instrument returns for its current point setting; stop the acquisition first for a stable one. The data format is set for the transfer and restored afterwards. The path must be absolute and must not exist yet. ${SCOPE_REQUIREMENT}`,
    inputSchema: z.strictObject({
      channel: z
        .number()
        .int()
        .min(1)
        .max(4)
        .describe("Analog channel, 1 to 4."),
      output_path: localPathStringSchema.describe(
        "Absolute path for the CSV, which must not exist yet.",
      ),
    }),
    outputSchema: evidenceResultOf(exportResult),
    examples: [
      {
        title: "Export channel 1",
        input: { channel: 1, output_path: "/tmp/channel1.csv" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
