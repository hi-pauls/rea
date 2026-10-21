import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AnalysisInputError } from "../../../src/domain/analysisErrorCore.js";
import {
  parseSaleaeChannels,
  parseSaleaeDevices,
  SaleaeLogicManager,
  saleaeExportCommand,
} from "../../../src/saleae/SaleaeLogicManager.js";
import { takeSaleaeReply } from "../../../src/saleae/SaleaeSocketClient.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * A stand-in Logic: answers each NUL-terminated command through `answer`, and
 * records every command it saw. CAPTURE is acknowledged only after
 * `captureMs`, the way Logic acknowledges it when the capture ends.
 */
const fakeLogic = async (
  answer: (command: string, socket: Socket) => string | undefined,
  captureMs = 50,
) => {
  const seen: string[] = [];
  let capturing = false;
  const server: Server = createServer((socket) => {
    let tail = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      const parts = `${tail}${chunk}`.split("\u0000");
      tail = parts.pop() ?? "";
      for (const command of parts) {
        seen.push(command);
        if (command === "CAPTURE") {
          capturing = true;
          setTimeout(() => {
            capturing = false;
            socket.write("ACK");
          }, captureMs);
          continue;
        }
        if (command === "IS_PROCESSING_COMPLETE") {
          socket.write(capturing ? "NAK" : "TRUE\nACK");
          continue;
        }
        const reply = answer(command, socket);
        if (reply !== undefined) socket.write(reply);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("The fake Logic has no port.");
  return {
    seen,
    environment: {
      REA_SALEAE_HOST: "127.0.0.1",
      REA_SALEAE_PORT: String(address.port),
    },
  };
};

const manager = (
  options: ConstructorParameters<typeof SaleaeLogicManager>[0],
): SaleaeLogicManager => {
  const created = new SaleaeLogicManager(options);
  cleanups.push(async () => created.close());
  return created;
};

const devices =
  "1, Logic 8, LOGIC_8_DEVICE, 0x2f3b, ACTIVE\n2, Logic Pro 16, LOGIC_PRO_16_DEVICE, 0x1a\nACK";

describe("Logic reply framing and parsing", () => {
  it("splits an acknowledged reply, a refusal and an incomplete reply", () => {
    expect(takeSaleaeReply("TRUE\nACKrest")).toEqual({
      reply: { status: "ack", text: "TRUE\n" },
      rest: "rest",
    });
    expect(takeSaleaeReply("NAKnext")).toEqual({
      reply: { status: "nak" },
      rest: "next",
    });
    expect(takeSaleaeReply("1, Logic 8, LOGIC_8_DE")).toBeUndefined();
  });

  it("parses devices, the active flag and channels", () => {
    expect(parseSaleaeDevices(devices.replace("ACK", ""))).toEqual([
      {
        index: 1,
        name: "Logic 8",
        type: "LOGIC_8_DEVICE",
        id: "0x2f3b",
        active: true,
      },
      {
        index: 2,
        name: "Logic Pro 16",
        type: "LOGIC_PRO_16_DEVICE",
        id: "0x1a",
        active: false,
      },
    ]);
    expect(
      parseSaleaeChannels("digital_channels, 0, 1, 7, analog_channels, 2"),
    ).toEqual({ digital: [0, 1, 7], analog: [2] });
    expect(parseSaleaeChannels("digital_channels, 3")).toEqual({
      digital: [3],
      analog: [],
    });
  });

  it("builds the export commands Logic expects", () => {
    expect(saleaeExportCommand("/tmp/a.vcd", "vcd", [0, 3])).toBe(
      "EXPORT_DATA2, /tmp/a.vcd, SPECIFIC_CHANNELS, DIGITAL_ONLY, 0 DIGITAL, 3 DIGITAL, ALL_TIME, VCD",
    );
    expect(saleaeExportCommand("/tmp/a.csv", "csv", null)).toBe(
      "EXPORT_DATA2, /tmp/a.csv, ALL_CHANNELS, ALL_TIME, CSV, HEADERS, COMMA, TIME_STAMP, SEPARATE, ROW_PER_CHANGE, DEC",
    );
  });
});

describe("Saleae Logic manager", () => {
  it("reports devices, channels and processing state", async () => {
    const logic = await fakeLogic((command) =>
      command === "GET_CONNECTED_DEVICES"
        ? devices
        : command === "GET_ACTIVE_CHANNELS"
          ? "digital_channels, 0, 1, analog_channels\nACK"
          : "NAK",
    );
    const inspected = await manager({
      environment: logic.environment,
    }).inspect();
    expect(
      inspected.ok ? inspected.value : inspected.error.message,
    ).toMatchObject({
      devices: [
        { index: 1, active: true },
        { index: 2, active: false },
      ],
      active_channels: { digital: [0, 1], analog: [] },
      processing_complete: true,
    });
  });

  it("arms before raising Logic and keeps later replies aligned", async () => {
    const logic = await fakeLogic(() => "NAK", 100);
    const order: string[] = [];
    const logicManager = manager({
      environment: logic.environment,
      platform: "darwin",
      focus: async (platform) => {
        // The command is on the wire before the window is raised; give it the
        // loopback hop to arrive, and no more.
        for (let wait = 0; !logic.seen.includes("CAPTURE") && wait < 20; wait++)
          await new Promise((resolve) => setTimeout(resolve, 10));
        order.push(`focus:${platform}`, `after:${logic.seen.join("|")}`);
        return { focused: true, detail: "raised" };
      },
    });
    const started = await logicManager.startCapture({ focus: true });
    expect(started.ok ? started.value : started.error.message).toEqual({
      armed: true,
      focus: { focused: true, detail: "raised" },
    });
    expect(order).toEqual(["focus:darwin", "after:CAPTURE"]);
    const during = await logicManager.status();
    expect(during.ok && during.value.processing_complete).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // The capture's own late ACK must not be read as the reply to this status.
    const after = await logicManager.status();
    expect(after.ok && after.value.processing_complete).toBe(true);
  });

  it("does not touch the window unless asked", async () => {
    const logic = await fakeLogic(() => "NAK");
    let raised = false;
    const started = await manager({
      environment: logic.environment,
      focus: async () => {
        raised = true;
        return { focused: true, detail: "raised" };
      },
    }).startCapture({ focus: false });
    expect(started.ok && started.value.focus).toBeNull();
    expect(raised).toBe(false);
  });

  it("names the scripting socket when Logic is not reachable", async () => {
    const closed = await fakeLogic(() => "NAK");
    const port = closed.environment.REA_SALEAE_PORT;
    await cleanups.pop()?.();
    const inspected = await manager({
      environment: { REA_SALEAE_HOST: "127.0.0.1", REA_SALEAE_PORT: port },
    }).inspect();
    expect(!inspected.ok && inspected.error.message).toContain(
      "scripting socket server enabled",
    );
  });
});

describe("Saleae Logic export", () => {
  it("exports through Logic and reports the written file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-saleae-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const output = join(directory, "capture.vcd");
    const content = "$timescale 1 ns $end\n#0 1!\n";
    const logic = await fakeLogic((command) => {
      if (command === "GET_ACTIVE_CHANNELS")
        return "digital_channels, 0, 2, analog_channels, 0\nACK";
      if (!command.startsWith("EXPORT_DATA2")) return "NAK";
      // Logic writes the file on its own, after acknowledging the command.
      setTimeout(() => void writeFile(output, content), 30);
      return "ACK";
    });
    const exported = await manager({ environment: logic.environment }).export({
      outputPath: output,
      format: "vcd",
    });
    expect(exported.ok ? "exported" : exported.error.message).toBe("exported");
    if (!exported.ok) return;
    expect(logic.seen).toContain(saleaeExportCommand(output, "vcd", [0, 2]));
    expect(exported.value.evidence.normalized_result).toEqual({
      path: output,
      format: "vcd",
      bytes: Buffer.byteLength(content),
      sha256: createHash("sha256")
        .update(await readFile(output))
        .digest("hex"),
    });
  });

  it("refuses an export with only analog channels active", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-saleae-analog-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const logic = await fakeLogic((command) =>
      command === "GET_ACTIVE_CHANNELS"
        ? "digital_channels, analog_channels, 1\nACK"
        : "ACK",
    );
    const exported = await manager({ environment: logic.environment }).export({
      outputPath: join(directory, "capture.vcd"),
      format: "vcd",
    });
    expect(!exported.ok && exported.error.message).toContain(
      "No digital channel is active",
    );
    expect(
      logic.seen.some((command) => command.startsWith("EXPORT_DATA2")),
    ).toBe(false);
  });

  it.each([
    ["relative/capture.vcd", "must be absolute"],
    [join(tmpdir(), "a,b.vcd"), "must not contain a comma"],
    [
      join(tmpdir(), "no-such-directory-rea", "capture.vcd"),
      "directory does not exist",
    ],
  ])("refuses the export path %j", async (path, reason) => {
    const exported = await manager({ environment: {} }).export({
      outputPath: path,
      format: "vcd",
    });
    expect(exported.ok).toBe(false);
    if (!exported.ok) {
      expect(exported.error).toBeInstanceOf(AnalysisInputError);
      expect(
        (exported.error as AnalysisInputError).issues[0]?.message,
      ).toContain(reason);
    }
  });

  it("refuses to let Logic overwrite an existing file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-saleae-exists-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const output = join(directory, "capture.vcd");
    await writeFile(output, "kept");
    const exported = await manager({ environment: {} }).export({
      outputPath: output,
      format: "vcd",
    });
    expect(!exported.ok && exported.error).toBeInstanceOf(AnalysisInputError);
    expect(await readFile(output, "utf8")).toBe("kept");
  });
});
