import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { err, ok, type Result } from "../domain/result.js";
import { ScpiSocketClient } from "../scpi/ScpiSocketClient.js";

export const OSCILLOSCOPE_PROVIDER_IDENTITY = {
  id: "rohde-schwarz-oscilloscope",
  name: "Rohde & Schwarz oscilloscope over SCPI",
  version: null,
} as const;

const DEFAULT_PORT = 5025;
const CONNECT_TIMEOUT_MS = 3_000;
const QUERY_TIMEOUT_MS = 10_000;
const WAVEFORM_TIMEOUT_MS = 120_000;
const CSV_ROWS_PER_WRITE = 8_192;

// Type aliases rather than interfaces, so results stay assignable to JsonValue.
export type OscilloscopeIdentity = {
  readonly manufacturer: string;
  readonly model: string;
  readonly serial: string;
  readonly firmware: string;
};

export type OscilloscopeChannel = {
  readonly channel: number;
  readonly enabled: boolean;
  readonly volts_per_division: number;
};

/** The acquisition states ACQuire:STATe? reports. */
export type AcquisitionState = "RUN" | "STOP" | "COMP" | "BRE";

/** @internal Pure parse of *IDN?: "manufacturer,model,serial,firmware". */
export const parseScpiIdentity = (text: string): OscilloscopeIdentity => {
  const [manufacturer = "", model = "", serial = "", firmware = ""] = text
    .split(",")
    .map((field) => field.trim());
  return { manufacturer, model, serial, firmware };
};

/** @internal The analog channel count is the last digit of the model, RTB2004 has 4. */
export const scopeChannelCount = (model: string): number =>
  Number(/(\d)$/u.exec(model)?.[1] ?? "0");

/** @internal Pure parse of CHANnel<n>:DATA:HEADer?: "x_start, x_stop, points, values per sample". */
export const parseWaveformHeader = (
  text: string,
): {
  readonly xStart: number;
  readonly xStop: number;
  readonly points: number;
  readonly valuesPerSample: number;
} => {
  const [xStart, xStop, points, valuesPerSample] = text
    .split(",")
    .map((field) => Number(field.trim()));
  if (
    [xStart, xStop, points, valuesPerSample].some(
      (value) => value === undefined || !Number.isFinite(value),
    )
  )
    throw new Error(
      `The waveform header ${JSON.stringify(text)} is not "x_start, x_stop, points, values per sample".`,
    );
  return {
    xStart: xStart ?? 0,
    xStop: xStop ?? 0,
    points: points ?? 0,
    valuesPerSample: valuesPerSample ?? 0,
  };
};

/**
 * @internal CSV rows of a REAL,32 big-endian waveform. A sample spans
 * (x_stop - x_start) / points; with two values per sample (peak detect) each
 * row carries the minimum and maximum.
 */
export function* waveformCsvRows(
  header: ReturnType<typeof parseWaveformHeader>,
  data: Buffer,
): Generator<string> {
  const minMax = header.valuesPerSample === 2;
  yield minMax ? "time_s,volts_min,volts_max\n" : "time_s,volts\n";
  const step = (header.xStop - header.xStart) / header.points;
  const width = 4 * header.valuesPerSample;
  for (let index = 0; index < header.points; index++) {
    const time = header.xStart + index * step;
    const offset = index * width;
    yield minMax
      ? `${String(time)},${String(data.readFloatBE(offset))},${String(data.readFloatBE(offset + 4))}\n`
      : `${String(time)},${String(data.readFloatBE(offset))}\n`;
  }
}

/** Drives a Rohde & Schwarz RTB2000-family oscilloscope over SCPI on its raw socket. */
export class OscilloscopeManager {
  readonly #host: string | undefined;
  readonly #port: number;
  readonly #queryTimeoutMs: number;
  #client: ScpiSocketClient | undefined;

  constructor(
    options: {
      readonly environment?: Readonly<NodeJS.ProcessEnv>;
      readonly queryTimeoutMs?: number;
    } = {},
  ) {
    const environment = options.environment ?? process.env;
    this.#host = environment.REA_OSCILLOSCOPE_HOST || undefined;
    this.#port = Number(environment.REA_OSCILLOSCOPE_PORT ?? DEFAULT_PORT);
    this.#queryTimeoutMs = options.queryTimeoutMs ?? QUERY_TIMEOUT_MS;
  }

  async inspect(): Promise<
    Result<
      {
        readonly identity: OscilloscopeIdentity;
        readonly channels: OscilloscopeChannel[];
        readonly seconds_per_division: number;
        readonly sample_rate_hz: number;
        readonly acquisition_state: string;
        readonly trigger_mode: string;
      },
      AnalysisError
    >
  > {
    return this.#guard("inspect_oscilloscope", async (client, identity) => {
      const channels: OscilloscopeChannel[] = [];
      for (
        let channel = 1;
        channel <= scopeChannelCount(identity.model);
        channel++
      )
        channels.push({
          channel,
          enabled:
            (await client.query(
              `CHAN${String(channel)}:STAT?`,
              this.#queryTimeoutMs,
            )) === "1",
          volts_per_division: Number(
            await client.query(
              `CHAN${String(channel)}:SCAL?`,
              this.#queryTimeoutMs,
            ),
          ),
        });
      return {
        identity,
        channels,
        seconds_per_division: Number(
          await client.query("TIM:SCAL?", this.#queryTimeoutMs),
        ),
        sample_rate_hz: Number(
          await client.query("ACQ:SRAT?", this.#queryTimeoutMs),
        ),
        acquisition_state: await client.query(
          "ACQ:STAT?",
          this.#queryTimeoutMs,
        ),
        trigger_mode: await client.query("TRIG:A:MODE?", this.#queryTimeoutMs),
      };
    });
  }

  async startSingle(): Promise<
    Result<
      { readonly armed: true; readonly acquisition_state: string },
      AnalysisError
    >
  > {
    return this.#guard("start_oscilloscope_acquisition", async (client) => {
      await client.send("SING");
      await this.#requireNoError(client, "SING");
      return {
        armed: true as const,
        acquisition_state: await client.query(
          "ACQ:STAT?",
          this.#queryTimeoutMs,
        ),
      };
    });
  }

  async status(): Promise<
    Result<
      { readonly acquisition_state: string; readonly complete: boolean },
      AnalysisError
    >
  > {
    return this.#guard("oscilloscope_acquisition_status", async (client) => {
      const state = await client.query("ACQ:STAT?", this.#queryTimeoutMs);
      return { acquisition_state: state, complete: state !== "RUN" };
    });
  }

  async stop(): Promise<
    Result<{ readonly acquisition_state: string }, AnalysisError>
  > {
    return this.#guard("stop_oscilloscope_acquisition", async (client) => {
      await client.send("STOP");
      await this.#requireNoError(client, "STOP");
      return {
        acquisition_state: await client.query(
          "ACQ:STAT?",
          this.#queryTimeoutMs,
        ),
      };
    });
  }

  async exportWaveform(input: {
    readonly channel: number;
    readonly outputPath: string;
  }): Promise<Result<{ readonly evidence: Evidence }, AnalysisError>> {
    const problem = await outputProblem(input.outputPath);
    if (problem !== undefined)
      return err(
        new AnalysisInputError("export_oscilloscope_waveform", undefined, [
          { path: ["output_path"], reason: "invalid_value", message: problem },
        ]),
      );
    return this.#guard(
      "export_oscilloscope_waveform",
      async (client, identity) => {
        const channel = String(input.channel);
        if (input.channel > scopeChannelCount(identity.model))
          throw new Error(
            `${identity.model} has no channel ${channel}; it has ${String(scopeChannelCount(identity.model))}.`,
          );
        if (
          (await client.query(`CHAN${channel}:STAT?`, this.#queryTimeoutMs)) !==
          "1"
        )
          throw new Error(
            `Channel ${channel} is switched off on the instrument.`,
          );
        const state = await client.query("ACQ:STAT?", this.#queryTimeoutMs);
        const { header, data } = await this.#readWaveform(client, channel);
        const written = await writeCsv(input.outputPath, header, data);
        const result = {
          path: input.outputPath,
          channel: input.channel,
          points: header.points,
          values_per_sample: header.valuesPerSample,
          x_start_s: header.xStart,
          x_stop_s: header.xStop,
          acquisition_state: state,
          bytes: written.bytes,
          sha256: written.sha256,
        };
        return {
          evidence: createEvidence(undefined, OSCILLOSCOPE_PROVIDER_IDENTITY, {
            predicateType: "rea.oscilloscope.waveform-export",
            operation: "export_oscilloscope_waveform",
            parameters: {
              channel: input.channel,
              output_path: input.outputPath,
            },
            result,
            rawResult: { ...result, identity: { ...identity } },
            subjectUnavailableReason:
              "The waveform is the instrument's current acquisition; its probe, trigger and settings are configured on the instrument, not by REA.",
            limitations: [
              "The waveform is the one CHANnel:DATA? returns for the instrument's current point setting, not necessarily the whole acquisition memory.",
              ...(state === "RUN"
                ? [
                    "The instrument was still acquiring, so the waveform is a snapshot of a running display.",
                  ]
                : []),
              "Times are computed from the waveform header as x_start + index * (x_stop - x_start) / points.",
            ],
          }),
        };
      },
    );
  }

  close(): void {
    this.#client?.close();
    this.#client = undefined;
  }

  async #readWaveform(
    client: ScpiSocketClient,
    channel: string,
  ): Promise<{
    readonly header: ReturnType<typeof parseWaveformHeader>;
    readonly data: Buffer;
  }> {
    const format = await client.query("FORM?", this.#queryTimeoutMs);
    const order = await client.query("FORM:BORD?", this.#queryTimeoutMs);
    try {
      await client.send("FORM REAL,32");
      await client.send("FORM:BORD MSBF");
      const header = parseWaveformHeader(
        await client.query(`CHAN${channel}:DATA:HEAD?`, this.#queryTimeoutMs),
      );
      if (header.valuesPerSample !== 1 && header.valuesPerSample !== 2)
        throw new Error(
          `The waveform has ${String(header.valuesPerSample)} values per sample; REA reads 1 or 2.`,
        );
      const data = await client.queryBlock(
        `CHAN${channel}:DATA?`,
        WAVEFORM_TIMEOUT_MS,
      );
      const expected = header.points * header.valuesPerSample * 4;
      if (data.length !== expected)
        throw new Error(
          `The waveform block holds ${String(data.length)} bytes where the header announces ${String(expected)}.`,
        );
      return { header, data };
    } finally {
      // *OPC? returns only once the instrument has applied the restore.
      if (!client.closed) {
        await client.send(`FORM ${format}`);
        await client.send(`FORM:BORD ${order}`);
        await client.query("*OPC?", this.#queryTimeoutMs);
      }
    }
  }

  async #requireNoError(
    client: ScpiSocketClient,
    command: string,
  ): Promise<void> {
    const error = await client.query("SYST:ERR?", this.#queryTimeoutMs);
    if (!error.startsWith("0,"))
      throw new Error(`The instrument reported ${error} after ${command}.`);
  }

  async #guard<Value>(
    operation: string,
    run: (
      client: ScpiSocketClient,
      identity: OscilloscopeIdentity,
    ) => Promise<Value>,
  ): Promise<Result<Value, AnalysisError>> {
    const host = this.#host;
    let outcome: Result<Value, AnalysisError>;
    try {
      if (host === undefined)
        throw new Error("REA_OSCILLOSCOPE_HOST names no instrument.");
      if (this.#client === undefined || this.#client.closed)
        this.#client = await ScpiSocketClient.connect({
          host,
          port: this.#port,
          timeoutMs: CONNECT_TIMEOUT_MS,
        });
      const identity = parseScpiIdentity(
        await this.#client.query("*IDN?", this.#queryTimeoutMs),
      );
      if (
        identity.manufacturer !== "Rohde&Schwarz" ||
        scopeChannelCount(identity.model) === 0
      )
        throw new Error(
          `The instrument identifies as ${JSON.stringify(`${identity.manufacturer},${identity.model}`)}; REA drives Rohde & Schwarz oscilloscopes such as the RTB2004.`,
        );
      outcome = ok(await run(this.#client, identity));
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      outcome = err(
        new AnalysisCapabilityUnavailableError(
          OSCILLOSCOPE_PROVIDER_IDENTITY.id,
          operation,
          `${detail} REA connects to the oscilloscope's SCPI socket at REA_OSCILLOSCOPE_HOST:REA_OSCILLOSCOPE_PORT (port default ${String(DEFAULT_PORT)}).`,
          { cause },
        ),
      );
    }
    return outcome;
  }
}

const outputProblem = async (path: string): Promise<string | undefined> => {
  if (!isAbsolute(path) || path.includes("\0"))
    return "The output path must be absolute and must not contain NUL.";
  if (
    await stat(path).then(
      () => true,
      () => false,
    )
  )
    return "The output path exists already; REA does not overwrite a file.";
  const parent = await stat(dirname(path)).catch(() => undefined);
  return parent?.isDirectory() === true
    ? undefined
    : "The output path's directory does not exist.";
};

const writeCsv = async (
  path: string,
  header: ReturnType<typeof parseWaveformHeader>,
  data: Buffer,
): Promise<{ readonly bytes: number; readonly sha256: string }> => {
  const hash = createHash("sha256");
  let bytes = 0;
  // "wx" refuses an existing file at the moment of creation, not only at validation.
  const file = await open(path, "wx");
  try {
    let pending: string[] = [];
    const flush = async () => {
      const chunk = Buffer.from(pending.join(""), "utf8");
      pending = [];
      hash.update(chunk);
      bytes += chunk.length;
      await file.write(chunk);
    };
    for (const row of waveformCsvRows(header, data)) {
      pending.push(row);
      if (pending.length >= CSV_ROWS_PER_WRITE) await flush();
    }
    await flush();
  } finally {
    await file.close();
  }
  return { bytes, sha256: hash.digest("hex") };
};
