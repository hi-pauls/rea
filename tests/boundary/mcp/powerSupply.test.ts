import { createServer, type Server } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { AnalysisInputError } from "../../../src/domain/analysisErrorCore.js";
import {
  parseApplied,
  PowerSupplyManager,
  powerSupplyChannelCount,
} from "../../../src/power/PowerSupplyManager.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type FakeChannel = {
  rating: string;
  ratedVolts: number;
  volts: number;
  amps: number;
  on: boolean;
  ovp: number;
  ovpOn: boolean;
  ocp: number;
  ocpOn: boolean;
};

/**
 * A stand-in DP832 keeping per-channel state. A channel switched on draws a
 * fixed 0.1 A at its setpoint; `tripOnSwitch` makes the output drop straight
 * back off, as a tripped protection does. Every line it received is recorded.
 */
const fakeSupply = async (
  options: { identity?: string; tripOnSwitch?: boolean; error?: string } = {},
) => {
  const seen: string[] = [];
  const channels: Record<string, FakeChannel> = {
    CH1: {
      rating: "30V/3A",
      ratedVolts: 30,
      volts: 12,
      amps: 1,
      on: false,
      ovp: 24.2,
      ovpOn: true,
      ocp: 3.2,
      ocpOn: true,
    },
    CH2: {
      rating: "30V/3A",
      ratedVolts: 30,
      volts: 7,
      amps: 0.5,
      on: false,
      ovp: 33,
      ovpOn: false,
      ocp: 3.3,
      ocpOn: false,
    },
    CH3: {
      rating: "5V/3A",
      ratedVolts: 5,
      volts: 5,
      amps: 0.5,
      on: false,
      ovp: 5.5,
      ovpOn: false,
      ocp: 3.3,
      ocpOn: false,
    },
  };
  const answer = (line: string): string | undefined => {
    if (line === "*IDN?")
      return (
        options.identity ?? "RIGOL TECHNOLOGIES,DP832,DP8C173003231,00.01.14"
      );
    if (line === ":SYST:ERR?") return options.error ?? '0,"No error"';
    const [command = "", argument = ""] = line.split(" ");
    const [name = "", ...values] = argument.split(",");
    const channel = channels[name];
    if (channel === undefined) return undefined;
    const fixed = (value: number) => value.toFixed(3);
    switch (command) {
      case ":APPL?":
        return `${name}:${channel.rating},${fixed(channel.volts)},${fixed(channel.amps)}`;
      case ":MEAS:ALL?":
        return channel.on
          ? `${channel.volts.toFixed(4)},0.1000,${fixed(channel.volts * 0.1)}`
          : "0.0000,0.0000,0.000";
      case ":OUTP?":
        return channel.on ? "ON" : "OFF";
      case ":OUTP:MODE?":
        return "CV";
      case ":OUTP:OVP?":
        return channel.ovpOn ? "ON" : "OFF";
      case ":OUTP:OVP:VAL?":
        return fixed(channel.ovp);
      case ":OUTP:OCP?":
        return channel.ocpOn ? "ON" : "OFF";
      case ":OUTP:OCP:VAL?":
        return fixed(channel.ocp);
      case ":APPL":
        channel.volts = Number(values[0]);
        channel.amps = Number(values[1]);
        return undefined;
      case ":OUTP":
        channel.on = values[0] === "ON" && options.tripOnSwitch !== true;
        return undefined;
      case ":OUTP:OVP:VAL":
        channel.ovp = Number(values[0]);
        return undefined;
      case ":OUTP:OVP":
        channel.ovpOn = values[0] === "ON";
        return undefined;
      case ":OUTP:OCP:VAL":
        channel.ocp = Number(values[0]);
        return undefined;
      case ":OUTP:OCP":
        channel.ocpOn = values[0] === "ON";
        return undefined;
      default:
        return undefined;
    }
  };
  const server: Server = createServer((socket) => {
    let tail = "";
    socket.setEncoding("latin1");
    socket.on("data", (chunk: string) => {
      const lines = `${tail}${chunk}`.split("\n");
      tail = lines.pop() ?? "";
      for (const line of lines) {
        seen.push(line);
        const reply = answer(line);
        if (reply !== undefined) socket.write(`${reply}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("The fake power supply has no port.");
  return {
    seen,
    channels,
    environment: {
      REA_POWER_SUPPLY_HOST: "127.0.0.1",
      REA_POWER_SUPPLY_PORT: String(address.port),
    },
  };
};

const manager = (
  environment: Readonly<NodeJS.ProcessEnv>,
): PowerSupplyManager => {
  const created = new PowerSupplyManager({ environment, settleMs: 10 });
  cleanups.push(async () => created.close());
  return created;
};

describe("DP800 parsing", () => {
  it("reads channel counts and applied settings", () => {
    expect(powerSupplyChannelCount("DP832")).toBe(3);
    expect(powerSupplyChannelCount("DP821")).toBe(2);
    expect(powerSupplyChannelCount("DP811")).toBe(1);
    expect(powerSupplyChannelCount("RTB2004")).toBe(0);
    expect(parseApplied("CH1:30V/3A,12.000,1.000")).toEqual({
      ratedVolts: 30,
      ratedAmps: 3,
      volts: 12,
      amps: 1,
    });
    expect(() => parseApplied("CH1,12")).toThrow("CHn:<V>V/<A>A");
  });
});

describe("Power supply manager", () => {
  it("reports every channel without sending a setting", async () => {
    const supply = await fakeSupply();
    const inspected = await manager(supply.environment).inspect();
    expect(
      inspected.ok ? inspected.value.channels.length : inspected.error.message,
    ).toBe(3);
    if (!inspected.ok) return;
    expect(inspected.value.identity.model).toBe("DP832");
    expect(inspected.value.channels[0]).toEqual({
      channel: 1,
      rated_volts: 30,
      rated_amps: 3,
      voltage_setpoint: 12,
      current_limit: 1,
      output_on: false,
      mode: "CV",
      measured_volts: 0,
      measured_amps: 0,
      measured_watts: 0,
      over_voltage_protection: { enabled: true, volts: 24.2 },
      over_current_protection: { enabled: true, amps: 3.2 },
    });
    expect(supply.seen.every((line) => line.includes("?"))).toBe(true);
  });

  it("sets a channel, keeps what is left out and switches protections on", async () => {
    const supply = await fakeSupply();
    const configured = await manager(supply.environment).configure({
      channel: 3,
      voltage: 3.3,
      overCurrentProtection: 0.25,
    });
    expect(
      configured.ok ? configured.value : configured.error.message,
    ).toMatchObject({
      channel: 3,
      voltage_setpoint: 3.3,
      current_limit: 0.5,
      output_on: false,
      over_current_protection: { enabled: true, amps: 0.25 },
      over_voltage_protection: { enabled: false },
    });
    expect(supply.seen).toContain(":APPL CH3,3.3,0.5");
  });

  it.each([
    [{ channel: 3, voltage: 6 }, "rated 5 V"],
    [{ channel: 1, currentLimit: 4 }, "rated 3 A"],
    [{ channel: 4, voltage: 1 }, "has no channel 4"],
  ])("refuses %j", async (input, reason) => {
    const supply = await fakeSupply();
    const configured = await manager(supply.environment).configure(input);
    expect(!configured.ok && configured.error.message).toContain(reason);
    expect(supply.seen.some((line) => line.startsWith(":APPL "))).toBe(false);
  });

  it("refuses a configuration that sets nothing", async () => {
    const configured = await manager({}).configure({ channel: 1 });
    expect(!configured.ok && configured.error).toBeInstanceOf(
      AnalysisInputError,
    );
  });

  it("reports an instrument error after a setting", async () => {
    const supply = await fakeSupply({ error: '-222,"Data out of range"' });
    const configured = await manager(supply.environment).configure({
      channel: 1,
      voltage: 5,
    });
    expect(!configured.ok && configured.error.message).toContain(
      '-222,"Data out of range" after configuring channel 1',
    );
  });

  it("switches an output on and off with its measurement", async () => {
    const supply = await fakeSupply();
    const supplyManager = manager(supply.environment);
    const on = await supplyManager.setOutput({ channel: 2, on: true });
    expect(on.ok ? on.value : on.error.message).toMatchObject({
      output_on: true,
      measured_volts: 7,
      measured_amps: 0.1,
    });
    const off = await supplyManager.setOutput({ channel: 2, on: false });
    expect(off.ok && off.value.output_on).toBe(false);
    expect(supply.channels.CH2?.on).toBe(false);
  });

  it("fails when the output does not hold the requested state", async () => {
    const supply = await fakeSupply({ tripOnSwitch: true });
    const on = await manager(supply.environment).setOutput({
      channel: 1,
      on: true,
    });
    expect(!on.ok && on.error.message).toContain(
      "a protection may have tripped",
    );
  });

  it("refuses an instrument that is not a DP800 and names the configuration", async () => {
    const supply = await fakeSupply({
      identity: "RIGOL TECHNOLOGIES,DS1054Z,1,1",
    });
    const inspected = await manager(supply.environment).inspect();
    expect(!inspected.ok && inspected.error.message).toContain(
      '"RIGOL TECHNOLOGIES,DS1054Z"',
    );
    const unset = await manager({}).inspect();
    expect(!unset.ok && unset.error.message).toContain(
      "REA_POWER_SUPPLY_HOST names no instrument",
    );
  });
});
