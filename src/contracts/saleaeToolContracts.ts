import { z } from "zod";

import { localPathStringSchema } from "../domain/localPath.js";
import type { ToolContract } from "./toolContractTypes.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "./toolEffects.js";

const LOGIC_REQUIREMENT =
  "Saleae Logic 1.x must already be running with its scripting socket server enabled; REA connects to REA_SALEAE_HOST:REA_SALEAE_PORT (default 127.0.0.1:10429) and does not start Logic.";

const device = z.strictObject({
  index: z.number().int(),
  name: z.string(),
  type: z.string(),
  id: z.string(),
  active: z.boolean(),
});
const channels = z.strictObject({
  digital: z.array(z.number().int()),
  analog: z.array(z.number().int()),
});
const exportResult = z.strictObject({
  path: z.string(),
  format: z.enum(["vcd", "csv"]),
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
});

/** Saleae Logic 1.x logic-analyzer contracts over Logic's scripting socket. */
export const SALEAE_TOOL_CONTRACTS = [
  {
    name: "inspect_saleae_logic",
    ...toolContractMetadata("inspect_saleae_logic"),
    kind: "native-provider",
    description: `Report the devices Logic knows, the active device's enabled channels, and whether Logic has finished processing its last capture. Without real hardware Logic lists simulated devices. ${LOGIC_REQUIREMENT}`,
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({
      devices: z.array(device),
      active_channels: channels.nullable(),
      processing_complete: z.boolean(),
    }),
    examples: [{ title: "Inspect Logic", input: {} }],
  },
  {
    name: "start_saleae_capture",
    ...toolContractMetadata("start_saleae_capture"),
    kind: "native-provider",
    description: `Arm a capture with the trigger, sample rate and duration configured in Logic's own window, and return at once; the capture waits for its trigger, so arm it before the event, such as before uploading firmware. With focus true, REA then brings Logic's window to the front, which keeps macOS from stalling a background Logic; this takes the keyboard focus from whatever the user is doing. Check saleae_capture_status, then export_saleae_capture. ${LOGIC_REQUIREMENT}`,
    inputSchema: z.strictObject({
      focus: z
        .boolean()
        .optional()
        .describe(
          "Bring Logic's window to the front after arming (osascript on macOS, WScript AppActivate on Windows, wmctrl on Linux). Defaults to false.",
        ),
    }),
    outputSchema: z.strictObject({
      armed: z.literal(true),
      focus: z
        .strictObject({ focused: z.boolean(), detail: z.string() })
        .nullable(),
    }),
    examples: [
      { title: "Arm a capture and raise Logic", input: { focus: true } },
    ],
  },
  {
    name: "saleae_capture_status",
    ...toolContractMetadata("saleae_capture_status"),
    kind: "native-provider",
    description: `Report whether Logic has finished capturing and processing; false while a capture still waits for its trigger or records. ${LOGIC_REQUIREMENT}`,
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({ processing_complete: z.boolean() }),
    examples: [{ title: "Check the capture", input: {} }],
  },
  {
    name: "stop_saleae_capture",
    ...toolContractMetadata("stop_saleae_capture"),
    kind: "native-provider",
    description: `Stop the running capture and report whether Logic kept any data. ${LOGIC_REQUIREMENT}`,
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({ data_captured: z.boolean() }),
    examples: [{ title: "Stop the capture", input: {} }],
  },
  {
    name: "export_saleae_capture",
    ...toolContractMetadata("export_saleae_capture"),
    kind: "native-provider",
    description: `Wait until Logic has finished processing, then have Logic write the active digital channels of the open capture to output_path, and return its size and SHA-256 with Evidence; analog channels are left out. vcd can be decoded with decode_signal_recording and input_format vcd; csv has one column per channel and a row per change. The path must be absolute, must not exist yet, must not contain a comma, and must be on the host Logic runs on. ${LOGIC_REQUIREMENT}`,
    inputSchema: z.strictObject({
      output_path: localPathStringSchema.describe(
        "Absolute path for the export, which must not exist yet.",
      ),
      format: z
        .enum(["vcd", "csv"])
        .optional()
        .describe("Export format; defaults to vcd."),
    }),
    outputSchema: evidenceResultOf(exportResult),
    examples: [
      {
        title: "Export the capture for sigrok",
        input: { output_path: "/tmp/capture.vcd", format: "vcd" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
