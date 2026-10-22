import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { err, ok, type Result } from "../domain/result.js";
import { ScpiSocketClient } from "../scpi/ScpiSocketClient.js";

export const POWER_SUPPLY_PROVIDER_IDENTITY = {
  id: "rigol-power-supply",
  name: "Rigol DP800 power supply over SCPI",
  version: null,
} as const;

const DEFAULT_PORT = 5555;
// The DP832's LAN stack can take several seconds to accept the first connection.
const CONNECT_TIMEOUT_MS = 15_000;
const QUERY_TIMEOUT_MS = 10_000;
const SETTLE_MS = 500;

export type PowerSupplyIdentity = {
  readonly manufacturer: string;
  readonly model: string;
  readonly serial: string;
  readonly firmware: string;
};

export type PowerSupplyChannel = {
  readonly channel: number;
  readonly rated_volts: number;
  readonly rated_amps: number;
  readonly voltage_setpoint: number;
  readonly current_limit: number;
  readonly output_on: boolean;
  readonly mode: string;
  readonly measured_volts: number;
  readonly measured_amps: number;
  readonly measured_watts: number;
  readonly over_voltage_protection: {
    readonly enabled: boolean;
    readonly volts: number;
  };
  readonly over_current_protection: {
    readonly enabled: boolean;
    readonly amps: number;
  };
};

/** @internal The DP800 channel count is the model's third digit: DP832 has 3, DP821 has 2. */
export const powerSupplyChannelCount = (model: string): number =>
  Number(/^DP8(\d)\d/u.exec(model)?.[1] ?? "0");

/** @internal Pure parse of :APPLy? CHn: "CH1:30V/3A,12.000,1.000". */
export const parseApplied = (
  text: string,
): {
  readonly ratedVolts: number;
  readonly ratedAmps: number;
  readonly volts: number;
  readonly amps: number;
} => {
  const match =
    /^CH\d:(\d+(?:\.\d+)?)V\/(\d+(?:\.\d+)?)A,([\d.]+),([\d.]+)$/u.exec(text);
  if (match === null)
    throw new Error(
      `The channel setting ${JSON.stringify(text)} is not "CHn:<V>V/<A>A,<volts>,<amps>".`,
    );
  return {
    ratedVolts: Number(match[1]),
    ratedAmps: Number(match[2]),
    volts: Number(match[3]),
    amps: Number(match[4]),
  };
};

/** Drives a Rigol DP800-series bench power supply over SCPI on its raw socket. */
export class PowerSupplyManager {
  readonly #host: string | undefined;
  readonly #port: number;
  readonly #settleMs: number;
  #client: ScpiSocketClient | undefined;

  constructor(
    options: {
      readonly environment?: Readonly<NodeJS.ProcessEnv>;
      readonly settleMs?: number;
    } = {},
  ) {
    const environment = options.environment ?? process.env;
    this.#host = environment.REA_POWER_SUPPLY_HOST || undefined;
    this.#port = Number(environment.REA_POWER_SUPPLY_PORT ?? DEFAULT_PORT);
    this.#settleMs = options.settleMs ?? SETTLE_MS;
  }

  async inspect(): Promise<
    Result<
      {
        readonly identity: PowerSupplyIdentity;
        readonly channels: PowerSupplyChannel[];
      },
      AnalysisError
    >
  > {
    return this.#guard("inspect_power_supply", async (client, identity) => {
      const channels: PowerSupplyChannel[] = [];
      for (
        let channel = 1;
        channel <= powerSupplyChannelCount(identity.model);
        channel++
      )
        channels.push(await readChannel(client, channel));
      return { identity, channels };
    });
  }

  async configure(input: {
    readonly channel: number;
    readonly voltage?: number | undefined;
    readonly currentLimit?: number | undefined;
    readonly overVoltageProtection?: number | undefined;
    readonly overCurrentProtection?: number | undefined;
  }): Promise<Result<PowerSupplyChannel, AnalysisError>> {
    if (
      input.voltage === undefined &&
      input.currentLimit === undefined &&
      input.overVoltageProtection === undefined &&
      input.overCurrentProtection === undefined
    )
      return err(
        new AnalysisInputError("configure_power_supply_channel", undefined, [
          {
            path: ["voltage"],
            reason: "invalid_value",
            message:
              "Give at least one of voltage, current_limit, over_voltage_protection or over_current_protection.",
          },
        ]),
      );
    return this.#guard(
      "configure_power_supply_channel",
      async (client, identity) => {
        const channel = requireChannel(identity, input.channel);
        const applied = parseApplied(
          await client.query(`:APPL? CH${channel}`, QUERY_TIMEOUT_MS),
        );
        const volts = input.voltage ?? applied.volts;
        const amps = input.currentLimit ?? applied.amps;
        if (volts < 0 || volts > applied.ratedVolts)
          throw new Error(
            `Channel ${channel} is rated ${String(applied.ratedVolts)} V; ${String(volts)} V is outside 0 to ${String(applied.ratedVolts)}.`,
          );
        if (amps < 0 || amps > applied.ratedAmps)
          throw new Error(
            `Channel ${channel} is rated ${String(applied.ratedAmps)} A; ${String(amps)} A is outside 0 to ${String(applied.ratedAmps)}.`,
          );
        if (input.voltage !== undefined || input.currentLimit !== undefined)
          await client.send(
            `:APPL CH${channel},${String(volts)},${String(amps)}`,
          );
        if (input.overVoltageProtection !== undefined) {
          await client.send(
            `:OUTP:OVP:VAL CH${channel},${String(input.overVoltageProtection)}`,
          );
          await client.send(`:OUTP:OVP CH${channel},ON`);
        }
        if (input.overCurrentProtection !== undefined) {
          await client.send(
            `:OUTP:OCP:VAL CH${channel},${String(input.overCurrentProtection)}`,
          );
          await client.send(`:OUTP:OCP CH${channel},ON`);
        }
        await requireNoError(client, `configuring channel ${channel}`);
        return readChannel(client, input.channel);
      },
    );
  }

  async setOutput(input: {
    readonly channel: number;
    readonly on: boolean;
  }): Promise<Result<PowerSupplyChannel, AnalysisError>> {
    return this.#guard("set_power_supply_output", async (client, identity) => {
      const channel = requireChannel(identity, input.channel);
      await client.send(`:OUTP CH${channel},${input.on ? "ON" : "OFF"}`);
      await requireNoError(client, `switching channel ${channel}`);
      // The measurement lags the switch; read it once the output has settled.
      await new Promise((resolve) => setTimeout(resolve, this.#settleMs));
      const state = await readChannel(client, input.channel);
      if (state.output_on !== input.on)
        throw new Error(
          `Channel ${channel} reads ${state.output_on ? "on" : "off"} after being switched ${input.on ? "on" : "off"}; a protection may have tripped.`,
        );
      return state;
    });
  }

  close(): void {
    this.#client?.close();
    this.#client = undefined;
  }

  async #guard<Value>(
    operation: string,
    run: (
      client: ScpiSocketClient,
      identity: PowerSupplyIdentity,
    ) => Promise<Value>,
  ): Promise<Result<Value, AnalysisError>> {
    const host = this.#host;
    let outcome: Result<Value, AnalysisError>;
    try {
      if (host === undefined)
        throw new Error("REA_POWER_SUPPLY_HOST names no instrument.");
      if (this.#client === undefined || this.#client.closed)
        this.#client = await ScpiSocketClient.connect({
          host,
          port: this.#port,
          timeoutMs: CONNECT_TIMEOUT_MS,
        });
      const [manufacturer = "", model = "", serial = "", firmware = ""] = (
        await this.#client.query("*IDN?", QUERY_TIMEOUT_MS)
      )
        .split(",")
        .map((field) => field.trim());
      if (
        manufacturer !== "RIGOL TECHNOLOGIES" ||
        powerSupplyChannelCount(model) === 0
      )
        throw new Error(
          `The instrument identifies as ${JSON.stringify(`${manufacturer},${model}`)}; REA drives Rigol DP800 power supplies such as the DP832.`,
        );
      outcome = ok(
        await run(this.#client, { manufacturer, model, serial, firmware }),
      );
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      outcome = err(
        new AnalysisCapabilityUnavailableError(
          POWER_SUPPLY_PROVIDER_IDENTITY.id,
          operation,
          `${detail} REA connects to the power supply's SCPI socket at REA_POWER_SUPPLY_HOST:REA_POWER_SUPPLY_PORT (port default ${String(DEFAULT_PORT)}).`,
          { cause },
        ),
      );
    }
    return outcome;
  }
}

const requireChannel = (
  identity: PowerSupplyIdentity,
  channel: number,
): string => {
  const count = powerSupplyChannelCount(identity.model);
  if (channel < 1 || channel > count)
    throw new Error(
      `${identity.model} has no channel ${String(channel)}; it has ${String(count)}.`,
    );
  return String(channel);
};

const requireNoError = async (
  client: ScpiSocketClient,
  action: string,
): Promise<void> => {
  const error = await client.query(":SYST:ERR?", QUERY_TIMEOUT_MS);
  if (!error.startsWith("0,"))
    throw new Error(`The instrument reported ${error} after ${action}.`);
};

const readChannel = async (
  client: ScpiSocketClient,
  channel: number,
): Promise<PowerSupplyChannel> => {
  const name = `CH${String(channel)}`;
  const query = async (text: string) =>
    client.query(`${text} ${name}`, QUERY_TIMEOUT_MS);
  const applied = parseApplied(await query(":APPL?"));
  const [volts = Number.NaN, amps = Number.NaN, watts = Number.NaN] = (
    await query(":MEAS:ALL?")
  )
    .split(",")
    .map(Number);
  return {
    channel,
    rated_volts: applied.ratedVolts,
    rated_amps: applied.ratedAmps,
    voltage_setpoint: applied.volts,
    current_limit: applied.amps,
    output_on: (await query(":OUTP?")) === "ON",
    mode: await query(":OUTP:MODE?"),
    measured_volts: volts,
    measured_amps: amps,
    measured_watts: watts,
    over_voltage_protection: {
      enabled: (await query(":OUTP:OVP?")) === "ON",
      volts: Number(await query(":OUTP:OVP:VAL?")),
    },
    over_current_protection: {
      enabled: (await query(":OUTP:OCP?")) === "ON",
      amps: Number(await query(":OUTP:OCP:VAL?")),
    },
  };
};
