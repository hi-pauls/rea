import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute } from "node:path";

import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { err, ok, type Result } from "../domain/result.js";
import { runOwnedCommand } from "../process/OwnedCommand.js";
import { SaleaeSocketClient, type SaleaeReply } from "./SaleaeSocketClient.js";

export const SALEAE_PROVIDER_IDENTITY = {
  id: "saleae-logic",
  name: "Saleae Logic 1.x",
  version: null,
} as const;

const DEFAULT_PORT = 10429;
const CONNECT_TIMEOUT_MS = 3_000;
const COMMAND_TIMEOUT_MS = 10_000;
const EXPORT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 250;
const FOCUS_TIMEOUT_MS = 10_000;

export interface SaleaeDevice {
  readonly index: number;
  readonly name: string;
  readonly type: string;
  readonly id: string;
  readonly active: boolean;
}

export type SaleaeExportFormat = "vcd" | "csv";

/** How REA brings Logic to the front; App Nap stalls a background Logic on macOS. */
export type SaleaeFocusRunner = (
  platform: NodeJS.Platform,
) => Promise<{ readonly focused: boolean; readonly detail: string }>;

/** @internal Pure parse of GET_CONNECTED_DEVICES: "index, name, type, id[, ACTIVE]" lines. */
export const parseSaleaeDevices = (text: string): readonly SaleaeDevice[] =>
  text
    .split("\n")
    .map((line) => line.split(",").map((field) => field.trim()))
    .filter((fields) => fields.length >= 4 && /^\d+$/u.test(fields[0] ?? ""))
    .map(([index, name, type, id, active]) => ({
      index: Number(index),
      name: name ?? "",
      type: type ?? "",
      id: id ?? "",
      active: (active ?? "").toUpperCase() === "ACTIVE",
    }));

/** @internal Pure parse of GET_ACTIVE_CHANNELS: "digital_channels, 0, 1, analog_channels, 0". */
export const parseSaleaeChannels = (
  text: string,
): {
  readonly digital: readonly number[];
  readonly analog: readonly number[];
} => {
  const fields = text.split(",").map((field) => field.trim());
  const analogAt = fields.indexOf("analog_channels");
  const numbers = (part: readonly string[]) =>
    part.filter((field) => /^\d+$/u.test(field)).map(Number);
  return {
    digital: numbers(fields.slice(1, analogAt < 0 ? undefined : analogAt)),
    analog: analogAt < 0 ? [] : numbers(fields.slice(analogAt + 1)),
  };
};

/**
 * @internal The EXPORT_DATA2 command for the whole capture. With analog channels
 * active, ALL_CHANNELS makes Logic 1.2.18 ignore VCD and write CSV to `<path>.csv`,
 * and channels listed without their " DIGITAL" suffix are acknowledged but never
 * written; `digital` is null only for devices that cannot report their channels.
 */
export const saleaeExportCommand = (
  path: string,
  format: SaleaeExportFormat,
  digital: readonly number[] | null,
): string =>
  [
    "EXPORT_DATA2",
    path,
    ...(digital === null
      ? ["ALL_CHANNELS"]
      : [
          "SPECIFIC_CHANNELS",
          "DIGITAL_ONLY",
          ...digital.map((channel) => `${String(channel)} DIGITAL`),
        ]),
    "ALL_TIME",
    ...(format === "vcd"
      ? ["VCD"]
      : [
          "CSV",
          "HEADERS",
          "COMMA",
          "TIME_STAMP",
          "SEPARATE",
          "ROW_PER_CHANGE",
          "DEC",
        ]),
  ].join(", ");

const focusCommands: Readonly<
  Partial<Record<NodeJS.Platform, { command: string; arguments: string[] }>>
> = {
  darwin: {
    command: "/usr/bin/osascript",
    arguments: ["-e", 'tell application "Logic" to activate'],
  },
  win32: {
    command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    arguments: [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "if (-not (New-Object -ComObject WScript.Shell).AppActivate('Logic')) { exit 3 }",
    ],
  },
  linux: { command: "/usr/bin/wmctrl", arguments: ["-a", "Logic"] },
};

const defaultFocus: SaleaeFocusRunner = async (platform) => {
  const focus = focusCommands[platform];
  if (focus === undefined)
    return {
      focused: false,
      detail: `REA cannot bring Logic to the front on ${platform}.`,
    };
  try {
    const snapshot = await runOwnedCommand(
      {
        ...focus,
        runId: `rea-saleae-focus-${randomUUID()}`,
        expectedCommand: null,
      },
      {
        timeoutMs: FOCUS_TIMEOUT_MS,
        diagnosticBytes: 16 * 1024,
        acceptNonZeroExit: true,
      },
    );
    return snapshot.exitCode === 0
      ? {
          focused: true,
          detail: `${focus.command} brought Logic to the front.`,
        }
      : {
          focused: false,
          detail: `${focus.command} exited ${String(snapshot.exitCode)}: ${snapshot.stderr.text.trim() || "no Logic window found"}`,
        };
  } catch (cause) {
    return {
      focused: false,
      detail: `${focus.command} could not run: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
};

const sha256File = async (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });

const pause = async (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Drives a running Saleae Logic 1.x through its scripting socket. */
export class SaleaeLogicManager {
  readonly #host: string;
  readonly #port: number;
  readonly #platform: NodeJS.Platform;
  readonly #focus: SaleaeFocusRunner;
  readonly #exportTimeoutMs: number;
  #client: SaleaeSocketClient | undefined;

  constructor(
    options: {
      readonly environment?: Readonly<NodeJS.ProcessEnv>;
      readonly platform?: NodeJS.Platform;
      readonly focus?: SaleaeFocusRunner;
      readonly exportTimeoutMs?: number;
    } = {},
  ) {
    const environment = options.environment ?? process.env;
    this.#host = environment.REA_SALEAE_HOST ?? "127.0.0.1";
    this.#port = Number(environment.REA_SALEAE_PORT ?? DEFAULT_PORT);
    this.#platform = options.platform ?? process.platform;
    this.#focus = options.focus ?? defaultFocus;
    this.#exportTimeoutMs = options.exportTimeoutMs ?? EXPORT_TIMEOUT_MS;
  }

  async inspect(): Promise<
    Result<
      {
        readonly devices: readonly SaleaeDevice[];
        readonly active_channels: {
          readonly digital: readonly number[];
          readonly analog: readonly number[];
        } | null;
        readonly processing_complete: boolean;
      },
      AnalysisError
    >
  > {
    return this.#guard("inspect_saleae_logic", async (client) => {
      const devices = parseSaleaeDevices(
        this.#text(
          await client.command("GET_CONNECTED_DEVICES", COMMAND_TIMEOUT_MS),
        ),
      );
      return {
        devices,
        active_channels: await this.#activeChannels(client),
        processing_complete: await this.#processingComplete(client),
      };
    });
  }

  async startCapture(options: { readonly focus: boolean }): Promise<
    Result<
      {
        readonly armed: true;
        readonly focus: {
          readonly focused: boolean;
          readonly detail: string;
        } | null;
      },
      AnalysisError
    >
  > {
    return this.#guard("start_saleae_capture", async (client) => {
      // Arm first, as the BuildSystem's run_logic.py does, then raise the window,
      // so a capture waiting on its trigger keeps running in the foreground.
      await client.startCapture();
      return {
        armed: true as const,
        focus: options.focus ? await this.#focus(this.#platform) : null,
      };
    });
  }

  async status(): Promise<
    Result<{ readonly processing_complete: boolean }, AnalysisError>
  > {
    return this.#guard("saleae_capture_status", async (client) => ({
      processing_complete: await this.#processingComplete(client),
    }));
  }

  async stopCapture(): Promise<
    Result<{ readonly data_captured: boolean }, AnalysisError>
  > {
    return this.#guard("stop_saleae_capture", async (client) => ({
      data_captured:
        (await client.command("STOP_CAPTURE", COMMAND_TIMEOUT_MS)).status ===
        "ack",
    }));
  }

  async export(input: {
    readonly outputPath: string;
    readonly format: SaleaeExportFormat;
  }): Promise<Result<{ readonly evidence: Evidence }, AnalysisError>> {
    const problem = await this.#outputProblem(input.outputPath);
    if (problem !== undefined)
      return err(
        new AnalysisInputError("export_saleae_capture", undefined, [
          { path: ["output_path"], reason: "invalid_value", message: problem },
        ]),
      );
    return this.#guard("export_saleae_capture", async (client) => {
      const deadline = Date.now() + this.#exportTimeoutMs;
      while (!(await this.#processingComplete(client))) {
        if (Date.now() > deadline)
          throw new Error(
            "Logic was still capturing or processing at the export deadline.",
          );
        await pause(POLL_INTERVAL_MS);
      }
      const channels = await this.#activeChannels(client);
      if (channels?.digital.length === 0)
        throw new Error(
          "No digital channel is active in Logic; REA exports digital channels only.",
        );
      const command = saleaeExportCommand(
        input.outputPath,
        input.format,
        channels?.digital ?? null,
      );
      if (
        (await client.command(command, this.#exportTimeoutMs)).status === "nak"
      )
        throw new Error(
          "Logic refused the export; is a capture open in Logic?",
        );
      const bytes = await this.#settledSize(input.outputPath, deadline);
      const result = {
        path: input.outputPath,
        format: input.format,
        bytes,
        sha256: await sha256File(input.outputPath),
      };
      return {
        evidence: createEvidence(undefined, SALEAE_PROVIDER_IDENTITY, {
          predicateType: "rea.logic-analyzer.capture-export",
          operation: "export_saleae_capture",
          parameters: { output_path: input.outputPath, format: input.format },
          result,
          rawResult: { ...result, command },
          subjectUnavailableReason:
            "The capture is the one open in Logic; its source device and trigger are configured in Logic, not by REA.",
          limitations: [
            "Logic writes the file itself; REA reports its size and SHA-256 once the size stopped changing.",
            "Only the active digital channels are exported; analog channels are left out.",
            "Channel names, trigger settings and sample rate are Logic's; a VCD export carries what Logic includes.",
          ],
        }),
      };
    });
  }

  close(): void {
    this.#client?.close();
    this.#client = undefined;
  }

  async #outputProblem(path: string): Promise<string | undefined> {
    if (!isAbsolute(path) || path.includes("\0"))
      return "The output path must be absolute and must not contain NUL.";
    // Logic's commands are comma-separated, with no quoting.
    if (path.includes(","))
      return "The output path must not contain a comma, which Logic would read as a separator.";
    if (
      await stat(path).then(
        () => true,
        () => false,
      )
    )
      return "The output path exists already; REA does not let Logic overwrite a file.";
    const parent = await stat(dirname(path)).catch(() => undefined);
    return parent?.isDirectory() === true
      ? undefined
      : "The output path's directory does not exist.";
  }

  // Logic writes the export on its own after acknowledging it; the size settling
  // twice in a row is taken as the end of the write.
  async #settledSize(path: string, deadline: number): Promise<number> {
    let previous = -1;
    for (;;) {
      const size = await stat(path).then(
        (entry) => entry.size,
        () => -1,
      );
      if (size >= 0 && size === previous) return size;
      if (Date.now() > deadline)
        throw new Error(
          size < 0
            ? `Logic acknowledged the export but ${path} did not appear; Logic writes on its own host.`
            : `${path} was still growing at the export deadline.`,
        );
      previous = size;
      await pause(POLL_INTERVAL_MS);
    }
  }

  async #activeChannels(client: SaleaeSocketClient): Promise<{
    readonly digital: readonly number[];
    readonly analog: readonly number[];
  } | null> {
    const reply = await client.command(
      "GET_ACTIVE_CHANNELS",
      COMMAND_TIMEOUT_MS,
    );
    return reply.status === "ack" ? parseSaleaeChannels(reply.text) : null;
  }

  async #processingComplete(client: SaleaeSocketClient): Promise<boolean> {
    const reply = await client.command(
      "IS_PROCESSING_COMPLETE",
      COMMAND_TIMEOUT_MS,
    );
    return reply.status === "ack" && reply.text.trim().toUpperCase() === "TRUE";
  }

  #text(reply: SaleaeReply): string {
    if (reply.status === "nak") throw new Error("Logic refused the command.");
    return reply.text;
  }

  async #guard<Value>(
    operation: string,
    run: (client: SaleaeSocketClient) => Promise<Value>,
  ): Promise<Result<Value, AnalysisError>> {
    try {
      if (this.#client === undefined || this.#client.closed)
        this.#client = await SaleaeSocketClient.connect({
          host: this.#host,
          port: this.#port,
          timeoutMs: CONNECT_TIMEOUT_MS,
        });
      return ok(await run(this.#client));
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      return err(
        new AnalysisCapabilityUnavailableError(
          SALEAE_PROVIDER_IDENTITY.id,
          operation,
          `${detail} Logic 1.x must be running with its scripting socket server enabled (Options, Preferences, Developer) on ${this.#host}:${String(this.#port)}; REA does not start Logic.`,
          { cause },
        ),
      );
    }
  }
}
