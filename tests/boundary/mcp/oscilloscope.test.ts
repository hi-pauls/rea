import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AnalysisInputError } from "../../../src/domain/analysisErrorCore.js";
import {
  OscilloscopeManager,
  parseWaveformHeader,
  scopeChannelCount,
  waveformCsvRows,
} from "../../../src/oscilloscope/OscilloscopeManager.js";
import {
  takeScpiBlock,
  takeScpiLine,
} from "../../../src/oscilloscope/ScpiSocketClient.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const IDENTITY = "Rohde&Schwarz,RTB2004,1333.1005k04/200358,02.300";

const floats = (values: readonly number[]): Buffer => {
  const data = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => data.writeFloatBE(value, index * 4));
  return data;
};

const block = (data: Buffer): Buffer => {
  const length = String(data.length);
  return Buffer.concat([
    Buffer.from(`#${String(length.length)}${length}`, "latin1"),
    data,
    Buffer.from("\n"),
  ]);
};

/**
 * A stand-in RTB2004 holding settings as SCPI state. Queries it knows are
 * answered; anything else, or a query overridden with null, is left unanswered
 * the way an instrument ignores a rejected query. Every line it received is
 * recorded.
 */
const fakeScope = async (
  overrides: Readonly<Record<string, string | Buffer | null>> = {},
) => {
  const seen: string[] = [];
  const state: Record<string, string> = {
    "FORM?": "ASC,0",
    "FORM:BORD?": "MSBF",
    "ACQ:STAT?": "RUN",
  };
  const replies: Record<string, string | Buffer | null> = {
    "*IDN?": IDENTITY,
    "CHAN1:STAT?": "1",
    "CHAN2:STAT?": "0",
    "CHAN3:STAT?": "0",
    "CHAN4:STAT?": "0",
    "CHAN1:SCAL?": "5.0E-01",
    "CHAN2:SCAL?": "1.0E+00",
    "CHAN3:SCAL?": "1.0E+00",
    "CHAN4:SCAL?": "1.0E+00",
    "TIM:SCAL?": "5.00E-04",
    "ACQ:SRAT?": "2.16E+07",
    "TRIG:A:MODE?": "AUTO",
    "SYST:ERR?": '0,"No error"',
    "*OPC?": "1",
    "CHAN1:DATA:HEAD?": "-1.0E-03,2.0E-03,3,1",
    "CHAN1:DATA?": block(floats([0.5, -0.25, 1.5])),
    ...overrides,
  };
  const server: Server = createServer((socket) => {
    let tail = "";
    socket.setEncoding("latin1");
    socket.on("data", (chunk: string) => {
      const lines = `${tail}${chunk}`.split("\n");
      tail = lines.pop() ?? "";
      for (const line of lines) {
        seen.push(line);
        if (line === "SING") state["ACQ:STAT?"] = "RUN";
        else if (line === "STOP") state["ACQ:STAT?"] = "STOP";
        else if (line.startsWith("FORM:BORD "))
          state["FORM:BORD?"] = line.slice(10);
        else if (line.startsWith("FORM ")) state["FORM?"] = line.slice(5);
        if (!line.endsWith("?")) continue;
        const reply = state[line] ?? replies[line];
        if (reply !== undefined && reply !== null)
          socket.write(typeof reply === "string" ? `${reply}\n` : reply);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("The fake oscilloscope has no port.");
  return {
    seen,
    state,
    environment: {
      REA_OSCILLOSCOPE_HOST: "127.0.0.1",
      REA_OSCILLOSCOPE_PORT: String(address.port),
    },
  };
};

const manager = (
  environment: Readonly<NodeJS.ProcessEnv>,
): OscilloscopeManager => {
  const created = new OscilloscopeManager({ environment });
  cleanups.push(async () => created.close());
  return created;
};

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "rea-oscilloscope-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

describe("SCPI framing and waveform parsing", () => {
  it("splits reply lines and definite-length blocks", () => {
    const taken = takeScpiLine(Buffer.from("RUN\r\nnext"));
    expect(taken?.line).toBe("RUN");
    expect(taken?.rest.toString()).toBe("next");
    expect(takeScpiLine(Buffer.from("RU"))).toBeUndefined();
    const data = Buffer.from([0x0a, 0x00, 0x23]);
    const split = takeScpiBlock(Buffer.concat([block(data), Buffer.from("x")]));
    expect(split?.block).toEqual(data);
    expect(split?.rest.toString()).toBe("x");
    // The terminator after the data has not arrived yet.
    expect(takeScpiBlock(block(data).subarray(0, 6))).toBeUndefined();
    expect(() => takeScpiBlock(Buffer.from("0,1\n"))).toThrow("#-block");
  });

  it("reads headers, channel counts and CSV rows", () => {
    const header = parseWaveformHeader("-1.0E-03,2.0E-03,3,1");
    expect(header).toEqual({
      xStart: -0.001,
      xStop: 0.002,
      points: 3,
      valuesPerSample: 1,
    });
    expect(() => parseWaveformHeader("1,2")).toThrow("x_start");
    expect(scopeChannelCount("RTB2004")).toBe(4);
    expect(scopeChannelCount("RTB2002")).toBe(2);
    expect([...waveformCsvRows(header, floats([0.5, -0.25, 1.5]))]).toEqual([
      "time_s,volts\n",
      "-0.001,0.5\n",
      "0,-0.25\n",
      "0.001,1.5\n",
    ]);
    expect([
      ...waveformCsvRows(
        { xStart: 0, xStop: 2, points: 1, valuesPerSample: 2 },
        floats([-1, 1]),
      ),
    ]).toEqual(["time_s,volts_min,volts_max\n", "0,-1,1\n"]);
  });
});

describe("Oscilloscope manager", () => {
  it("reports identity, channels and acquisition settings", async () => {
    const scope = await fakeScope();
    const inspected = await manager(scope.environment).inspect();
    expect(inspected.ok ? inspected.value : inspected.error.message).toEqual({
      identity: {
        manufacturer: "Rohde&Schwarz",
        model: "RTB2004",
        serial: "1333.1005k04/200358",
        firmware: "02.300",
      },
      channels: [
        { channel: 1, enabled: true, volts_per_division: 0.5 },
        { channel: 2, enabled: false, volts_per_division: 1 },
        { channel: 3, enabled: false, volts_per_division: 1 },
        { channel: 4, enabled: false, volts_per_division: 1 },
      ],
      seconds_per_division: 0.0005,
      sample_rate_hz: 21_600_000,
      acquisition_state: "RUN",
      trigger_mode: "AUTO",
    });
    expect(scope.seen.some((line) => !line.endsWith("?"))).toBe(false);
  });

  it("arms a single acquisition and stops", async () => {
    const scope = await fakeScope();
    const scopeManager = manager(scope.environment);
    const armed = await scopeManager.startSingle();
    expect(armed.ok ? armed.value : armed.error.message).toEqual({
      armed: true,
      acquisition_state: "RUN",
    });
    const running = await scopeManager.status();
    expect(running.ok && running.value.complete).toBe(false);
    const stopped = await scopeManager.stop();
    expect(stopped.ok ? stopped.value : stopped.error.message).toEqual({
      acquisition_state: "STOP",
    });
    const after = await scopeManager.status();
    expect(after.ok && after.value.complete).toBe(true);
    expect(scope.seen).toContain("SING");
  });

  it("reports an instrument error after a command", async () => {
    const scope = await fakeScope({
      "SYST:ERR?": '-113,"Undefined header"',
    });
    const armed = await manager(scope.environment).startSingle();
    expect(!armed.ok && armed.error.message).toContain(
      '-113,"Undefined header" after SING',
    );
  });
});

describe("Oscilloscope waveform export", () => {
  it("exports a waveform as CSV and restores the data format", async () => {
    const scope = await fakeScope();
    const output = join(await temporaryDirectory(), "channel1.csv");
    const exported = await manager(scope.environment).exportWaveform({
      channel: 1,
      outputPath: output,
    });
    expect(exported.ok ? "exported" : exported.error.message).toBe("exported");
    if (!exported.ok) return;
    const written = await readFile(output);
    expect(written.toString()).toBe(
      "time_s,volts\n-0.001,0.5\n0,-0.25\n0.001,1.5\n",
    );
    expect(exported.value.evidence.normalized_result).toEqual({
      path: output,
      channel: 1,
      points: 3,
      values_per_sample: 1,
      x_start_s: -0.001,
      x_stop_s: 0.002,
      acquisition_state: "RUN",
      bytes: written.length,
      sha256: createHash("sha256").update(written).digest("hex"),
    });
    expect(scope.state["FORM?"]).toBe("ASC,0");
    expect(scope.seen).toContain("FORM REAL,32");
  });

  it("refuses a waveform whose block disagrees with its header", async () => {
    const scope = await fakeScope({
      "CHAN1:DATA?": block(floats([0.5, -0.25])),
    });
    const output = join(await temporaryDirectory(), "short.csv");
    const exported = await manager(scope.environment).exportWaveform({
      channel: 1,
      outputPath: output,
    });
    expect(!exported.ok && exported.error.message).toContain(
      "holds 8 bytes where the header announces 12",
    );
    expect(scope.state["FORM?"]).toBe("ASC,0");
    await expect(readFile(output)).rejects.toThrow();
  });

  it.each([
    [2, "switched off"],
    [5, "has no channel 5"],
  ])("refuses channel %i", async (channel, reason) => {
    const scope = await fakeScope();
    const exported = await manager(scope.environment).exportWaveform({
      channel,
      outputPath: join(await temporaryDirectory(), "channel.csv"),
    });
    expect(!exported.ok && exported.error.message).toContain(reason);
  });

  it("refuses an existing or relative output path", async () => {
    const existing = join(await temporaryDirectory(), "kept.csv");
    await writeFile(existing, "kept");
    for (const path of [existing, "relative/channel.csv"]) {
      const exported = await manager({}).exportWaveform({
        channel: 1,
        outputPath: path,
      });
      expect(!exported.ok && exported.error).toBeInstanceOf(AnalysisInputError);
    }
    expect(await readFile(existing, "utf8")).toBe("kept");
  });
});

describe("Oscilloscope connection", () => {
  it("drops a connection whose query went unanswered", async () => {
    const scope = await fakeScope({ "TRIG:A:MODE?": null });
    const scopeManager = new OscilloscopeManager({
      environment: scope.environment,
      queryTimeoutMs: 200,
    });
    cleanups.push(async () => scopeManager.close());
    const inspected = await scopeManager.inspect();
    expect(!inspected.ok && inspected.error.message).toContain(
      'did not answer "TRIG:A:MODE?"',
    );
    const status = await scopeManager.status();
    expect(status.ok ? status.value : status.error.message).toEqual({
      acquisition_state: "RUN",
      complete: false,
    });
  });

  it("refuses an instrument that is not a Rohde & Schwarz oscilloscope", async () => {
    const scope = await fakeScope({ "*IDN?": "ACME,Meter,1,1" });
    const inspected = await manager(scope.environment).inspect();
    expect(!inspected.ok && inspected.error.message).toContain('"ACME,Meter"');
  });

  it("names the configuration when no instrument is set or reachable", async () => {
    const unset = await manager({}).inspect();
    expect(!unset.ok && unset.error.message).toContain(
      "REA_OSCILLOSCOPE_HOST names no instrument",
    );
    const closed = await fakeScope();
    await cleanups.pop()?.();
    const unreachable = await manager(closed.environment).inspect();
    expect(!unreachable.ok && unreachable.error.message).toContain(
      "REA_OSCILLOSCOPE_HOST:REA_OSCILLOSCOPE_PORT",
    );
  });
});
