import { z } from "zod";

import type { ToolContract } from "./toolContractTypes.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "./toolEffects.js";

const sessionId = z.string().uuid();
const port = z.number().int().min(1).max(65535);
const openOcdCommandResult = z.strictObject({
  command: z.string(),
  reply: z.string(),
  output_truncated: z.boolean(),
  completion_status: z.enum(["complete", "unknown"]),
});

/** OpenOCD session contracts for embedded targets behind a debug probe. */
export const OPENOCD_TOOL_CONTRACTS = [
  {
    name: "start_openocd_session",
    ...toolContractMetadata("start_openocd_session"),
    kind: "native-provider",
    description:
      "Start the operator-configured OpenOCD (REA_OPENOCD_COMMAND) for an embedded target behind a debug probe. config_files are chosen per call, typically one interface configuration such as interface/jlink.cfg or interface/stlink.cfg and one target configuration such as target/stm32f4x.cfg; each is resolved relative to the operator-configured roots in REA_OPENOCD_SCRIPT_ROOTS, which normally include OpenOCD's own scripts directory and the operator's board and CPU configurations. Absolute paths and parent traversal are rejected. OpenOCD initialization examines the target and can reset it, depending on the configuration. The session is ready once OpenOCD identifies itself on its TCL port. Its GDB server listens on gdb_port (default 3333, 0 disables it), so start_gdb_session with remote_target set to that port and debugger set to the chip's toolchain triple, such as arm-none-eabi, attaches the matching cross debugger.",
    inputSchema: z.strictObject({
      config_files: z
        .array(z.string().min(1))
        .min(1)
        .max(16)
        .describe(
          'OpenOCD configuration files in load order, relative to a configured script root, for example ["interface/jlink.cfg", "target/stm32f4x.cfg"].',
        ),
      gdb_port: z
        .union([z.literal(0), port])
        .optional()
        .describe(
          "Port for OpenOCD's GDB server; defaults to 3333, and 0 disables it.",
        ),
      tcl_port: port
        .optional()
        .describe(
          "Port for OpenOCD's TCL RPC server, which REA uses to send commands; defaults to 6666.",
        ),
    }),
    outputSchema: z.strictObject({
      session_id: sessionId,
      gdb_port: port.nullable(),
      tcl_port: port,
      config_files: z.array(z.string()),
    }),
    examples: [
      {
        title: "Attach a J-Link to an STM32F4",
        input: { config_files: ["interface/jlink.cfg", "target/stm32f4x.cfg"] },
      },
    ],
  },
  {
    name: "openocd_command",
    ...toolContractMetadata("openocd_command"),
    kind: "native-provider",
    description:
      "Run one unrestricted OpenOCD command through the session's TCL RPC port and return its reply inline with Evidence. Typical commands: halt, resume, reset halt, reg, mdw <address> <count> to read memory words, mww <address> <value> to write one, flash banks, flash info 0, flash read_bank 0 <file>, and program <file> verify. Commands can halt, reset, reprogram or erase the attached device and can write host files. A command deadline returns completion_status unknown while the device may still act on the command.",
    inputSchema: z.strictObject({
      session_id: sessionId,
      command: z.string().min(1),
    }),
    outputSchema: evidenceResultOf(openOcdCommandResult),
    examples: [
      {
        title: "Read four words of memory",
        input: {
          session_id: "00000000-0000-4000-8000-000000000001",
          command: "mdw 0x08000000 4",
        },
      },
    ],
  },
  {
    name: "openocd_session_status",
    ...toolContractMetadata("openocd_session_status"),
    kind: "native-provider",
    description:
      "Return the lifecycle state, ports, configuration files and bounded recent OpenOCD diagnostics for one REA OpenOCD session.",
    inputSchema: z.strictObject({ session_id: sessionId }),
    outputSchema: z.strictObject({
      session_id: sessionId,
      state: z.enum(["ready", "closed"]),
      gdb_port: port.nullable(),
      tcl_port: port,
      config_files: z.array(z.string()),
      stderr: z.string(),
      stderr_truncated: z.boolean(),
    }),
    examples: [
      {
        title: "Check OpenOCD session",
        input: { session_id: "00000000-0000-4000-8000-000000000001" },
      },
    ],
  },
  {
    name: "close_openocd_session",
    ...toolContractMetadata("close_openocd_session"),
    kind: "native-provider",
    description:
      "Shut down the owned OpenOCD process. REA neither resets nor halts the device during cleanup, but shutdown handlers in the configuration can act on it, so the target state is reported as unknown. Close any GDB session attached to this OpenOCD first.",
    inputSchema: z.strictObject({ session_id: sessionId }),
    outputSchema: z.strictObject({ target_state: z.enum(["unknown"]) }),
    examples: [
      {
        title: "Close OpenOCD session",
        input: { session_id: "00000000-0000-4000-8000-000000000001" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
