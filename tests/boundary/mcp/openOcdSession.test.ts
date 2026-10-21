import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AnalysisInputError } from "../../../src/domain/analysisErrorCore.js";
import { resolveOpenOcdConfigFile } from "../../../src/embedded/OpenOcdConfiguration.js";
import { OpenOcdSessionManager } from "../../../src/embedded/OpenOcdSessionManager.js";
import {
  OpenOcdTclClient,
  splitOpenOcdFrames,
} from "../../../src/embedded/OpenOcdTclClient.js";

const SUB = "\u001a";
const cleanups: (() => Promise<void>)[] = [];

const afterAllCleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

afterAll(async () => {
  for (const cleanup of afterAllCleanups.splice(0)) await cleanup();
});

const temporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

/** A TCL RPC peer that answers each framed request through `answer`. */
const listenTcl = async (
  answer: (command: string, socket: Socket) => string | undefined,
): Promise<number> => {
  const server: Server = createServer((socket) => {
    let tail = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      const parts = `${tail}${chunk}`.split(SUB);
      tail = parts.pop() ?? "";
      for (const command of parts) {
        const reply = answer(command, socket);
        if (reply !== undefined) socket.write(`${reply}${SUB}`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("The test TCL server has no port.");
  return address.port;
};

const inputIssue = (error: unknown) => {
  expect(error).toBeInstanceOf(AnalysisInputError);
  return (error as AnalysisInputError).issues[0];
};

describe("OpenOCD TCL framing", () => {
  it("splits complete frames from an unterminated tail", () => {
    expect(splitOpenOcdFrames(`a${SUB}b${SUB}par`)).toEqual({
      frames: ["a", "b"],
      tail: "par",
    });
    expect(splitOpenOcdFrames("no frame yet")).toEqual({
      frames: [],
      tail: "no frame yet",
    });
  });

  it("matches pipelined replies to commands in order", async () => {
    const port = await listenTcl((command) => `reply:${command}`);
    const client = await OpenOcdTclClient.connect({ port, timeoutMs: 2_000 });
    cleanups.push(async () => client.close());
    const [first, second] = await Promise.all([
      client.send("halt", 2_000),
      client.send("mdw 0x0 1", 2_000),
    ]);
    expect(first.text).toBe("reply:halt");
    expect(second.text).toBe("reply:mdw 0x0 1");
  });

  it("truncates a reply past the limit and reports it", async () => {
    const port = await listenTcl(() => "x".repeat(64));
    const client = await OpenOcdTclClient.connect({
      port,
      timeoutMs: 2_000,
      replyLimitBytes: 16,
    });
    cleanups.push(async () => client.close());
    const reply = await client.send("flash banks", 2_000);
    expect(reply).toEqual({ text: "x".repeat(16), truncated: true });
  });

  it("refuses a command carrying the protocol terminator", async () => {
    const port = await listenTcl(() => "never");
    const client = await OpenOcdTclClient.connect({ port, timeoutMs: 2_000 });
    cleanups.push(async () => client.close());
    await expect(client.send(`halt${SUB}reset`, 2_000)).rejects.toThrow(
      "protocol terminator",
    );
  });

  it("keeps later replies aligned after a command times out", async () => {
    // OpenOCD works through commands one at a time, so the late reply to a
    // timed-out command still arrives before the reply to the next one.
    let queue = Promise.resolve();
    const port = await listenTcl((command, socket) => {
      queue = queue.then(
        () =>
          new Promise<void>((resolve) =>
            setTimeout(
              () => {
                socket.write(`reply:${command}${SUB}`);
                resolve();
              },
              command === "slow" ? 300 : 0,
            ),
          ),
      );
      return undefined;
    });
    const client = await OpenOcdTclClient.connect({ port, timeoutMs: 2_000 });
    cleanups.push(async () => client.close());
    await expect(client.send("slow", 100)).rejects.toThrow("did not answer");
    await expect(client.send("next", 2_000)).resolves.toEqual({
      text: "reply:next",
      truncated: false,
    });
  });

  it("rejects pending commands when the peer closes", async () => {
    const port = await listenTcl((_command, socket) => {
      socket.destroy();
      return undefined;
    });
    const client = await OpenOcdTclClient.connect({ port, timeoutMs: 2_000 });
    await expect(client.send("shutdown", 2_000)).rejects.toThrow("closed");
  });
});

describe("OpenOCD configuration resolution", () => {
  const roots = [join(tmpdir(), "openocd-scripts"), join(tmpdir(), "board")];
  const present =
    (...paths: string[]) =>
    (path: string) =>
      paths.includes(path);

  it("prefers the first root that holds the file", () => {
    const inBoth = present(
      join(roots[0] ?? "", "interface", "jlink.cfg"),
      join(roots[1] ?? "", "interface", "jlink.cfg"),
    );
    expect(
      resolveOpenOcdConfigFile("interface/jlink.cfg", roots, inBoth),
    ).toEqual({ resolved: join(roots[0] ?? "", "interface", "jlink.cfg") });
  });

  it("finds a file that only a later root holds", () => {
    const boardFile = join(roots[1] ?? "", "teensy.cfg");
    expect(
      resolveOpenOcdConfigFile("teensy.cfg", roots, present(boardFile)),
    ).toEqual({ resolved: boardFile });
  });

  it("names a file that no root holds", () => {
    expect(
      resolveOpenOcdConfigFile("target/no-such-chip.cfg", roots, present()),
    ).toEqual({
      reason:
        "target/no-such-chip.cfg was not found in any configured script root",
    });
  });

  it.each([
    ["/etc/passwd", "relative to a configured script root"],
    ["../outside.cfg", "must not traverse"],
    ["interface/../../outside.cfg", "must not traverse"],
    ["", "non-empty"],
  ])("rejects %j", (candidate, reason) => {
    const outcome = resolveOpenOcdConfigFile(candidate, roots);
    expect("reason" in outcome && outcome.reason).toContain(reason);
  });

  it("rejects every file when no root is configured", () => {
    expect(
      resolveOpenOcdConfigFile("target/stm32f4x.cfg", [], () => true),
    ).toEqual({
      reason: "target/stm32f4x.cfg was not found in any configured script root",
    });
  });
});

describe("OpenOCD session refusals", () => {
  let configured: Record<string, string> = {};

  beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-openocd-refusals-"));
    afterAllCleanups.push(() => rm(root, { recursive: true, force: true }));
    for (const file of ["interface/jlink.cfg", "target/x.cfg"]) {
      await mkdir(join(root, file, ".."), { recursive: true });
      await writeFile(join(root, file), "# test configuration\n");
    }
    configured = {
      REA_OPENOCD_COMMAND: join(root, "openocd"),
      REA_OPENOCD_SCRIPT_ROOTS: root,
    };
  });

  it("names both variables when OpenOCD is not configured", async () => {
    const manager = new OpenOcdSessionManager({ environment: {} });
    const started = await manager.start({ configFiles: ["target/x.cfg"] });
    expect(!started.ok && started.error.message).toContain(
      "REA_OPENOCD_SCRIPT_ROOTS",
    );
  });

  it("names a relative script root instead of ignoring it", async () => {
    const manager = new OpenOcdSessionManager({
      environment: {
        ...configured,
        REA_OPENOCD_SCRIPT_ROOTS: `${tmpdir()}${delimiter}scripts`,
      },
    });
    const started = await manager.start({ configFiles: ["target/x.cfg"] });
    expect(!started.ok && started.error.message).toContain(
      "relative root scripts",
    );
  });

  it("requires at least one configuration file", async () => {
    const manager = new OpenOcdSessionManager({ environment: configured });
    const started = await manager.start({ configFiles: [] });
    expect(started.ok).toBe(false);
    if (!started.ok)
      expect(inputIssue(started.error)?.path).toEqual(["config_files"]);
  });

  it.each([
    ["../escape.cfg", "must not traverse"],
    ["target/no-such-chip.cfg", "was not found"],
  ])(
    "points at the offending configuration file %j",
    async (candidate, reason) => {
      const manager = new OpenOcdSessionManager({ environment: configured });
      const started = await manager.start({
        configFiles: ["interface/jlink.cfg", candidate],
      });
      expect(started.ok).toBe(false);
      if (!started.ok) {
        const issue = inputIssue(started.error);
        expect(issue?.path).toEqual(["config_files", 1]);
        expect(issue?.message).toContain(reason);
      }
    },
  );

  it("refuses a GDB port that collides with the TCL port", async () => {
    const manager = new OpenOcdSessionManager({ environment: configured });
    const started = await manager.start({
      configFiles: ["target/x.cfg"],
      gdbPort: 7000,
      tclPort: 7000,
    });
    expect(started.ok).toBe(false);
    if (!started.ok)
      expect(inputIssue(started.error)?.message).toContain("must differ");
  });
});

/**
 * A stand-in OpenOCD: reads the TCL port from its arguments, identifies itself
 * to `capture version`, prefixes every other reply with the command it saw,
 * and exits on shutdown. With FAKE_OPENOCD_FAIL set it behaves like a
 * configuration error instead: a diagnostic on stderr and a non-zero exit.
 */
const writeFakeOpenOcd = async (directory: string): Promise<string> => {
  const provider = join(directory, "fake-openocd.mjs");
  await writeFile(
    provider,
    `#!${process.execPath}
import { createServer } from 'node:net';
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (process.env.FAKE_OPENOCD_ARGS) appendFileSync(process.env.FAKE_OPENOCD_ARGS, JSON.stringify(args));
if (process.env.FAKE_OPENOCD_FAIL) {
  process.stderr.write("Error: Can't find target/missing.cfg\\n");
  process.exit(1);
}
const tclPort = Number(args[args.findIndex((arg) => arg.startsWith('tcl_port '))].slice(9));
const server = createServer((socket) => {
  let tail = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    const parts = (tail + chunk).split('\\u001a');
    tail = parts.pop();
    for (const command of parts) {
      if (command === 'shutdown') {
        socket.end('shutdown command invoked\\u001a', () => process.exit(0));
        return;
      }
      const reply = command === 'capture version'
        ? 'Open On-Chip Debugger 0.12.0 (fake)'
        : 'ran:' + command;
      socket.write(reply + '\\u001a');
    }
  });
});
process.stderr.write('Info : Listening on port ' + tclPort + ' for tcl connections\\n');
server.listen(tclPort, '127.0.0.1');
`,
  );
  await chmod(provider, 0o700);
  return provider;
};

const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string")
    throw new Error("No free port.");
  return address.port;
};

describe.skipIf(process.platform === "win32")(
  "OpenOCD session lifecycle",
  () => {
    it("starts, runs a command, reports status and shuts OpenOCD down", async () => {
      const directory = await temporaryDirectory("rea-openocd-");
      const roots = [join(directory, "scripts"), join(directory, "board")];
      // The interface file is in the first root and the target file only in
      // the second, so both roots must be searched.
      const interfaceFile = join(roots[0] ?? "", "interface", "jlink.cfg");
      const targetFile = join(roots[1] ?? "", "target", "stm32f4x.cfg");
      for (const file of [interfaceFile, targetFile]) {
        await mkdir(join(file, ".."), { recursive: true });
        await writeFile(file, "# test configuration\n");
      }
      const argsFile = join(directory, "args.json");
      const tclPort = await freePort();
      const manager = new OpenOcdSessionManager({
        environment: {
          REA_OPENOCD_COMMAND: await writeFakeOpenOcd(directory),
          REA_OPENOCD_SCRIPT_ROOTS: roots.join(delimiter),
          FAKE_OPENOCD_ARGS: argsFile,
        },
      });
      cleanups.push(() => manager.closeAll());
      const started = await manager.start({
        configFiles: ["interface/jlink.cfg", "target/stm32f4x.cfg"],
        tclPort,
        gdbPort: 0,
      });
      expect(started.ok ? "started" : started.error.message).toBe("started");
      if (!started.ok) return;
      expect(started.value).toMatchObject({
        gdb_port: null,
        tcl_port: tclPort,
      });
      const { readFile } = await import("node:fs/promises");
      // REA's ports come after the configuration files so they take precedence.
      expect(JSON.parse(await readFile(argsFile, "utf8"))).toEqual([
        "-s",
        roots[0],
        "-s",
        roots[1],
        "-f",
        interfaceFile,
        "-f",
        targetFile,
        "-c",
        "telnet_port disabled",
        "-c",
        `tcl_port ${String(tclPort)}`,
        "-c",
        "gdb_port 0",
      ]);
      const ran = await manager.execute(started.value.session_id, "mdw 0x0 1");
      expect(ran.ok).toBe(true);
      if (ran.ok)
        expect(ran.value.evidence.normalized_result).toMatchObject({
          reply: "ran:mdw 0x0 1",
          completion_status: "complete",
        });
      const status = manager.status(started.value.session_id);
      expect(status.ok && status.value.stderr).toContain("for tcl connections");
      const closed = await manager.close(started.value.session_id);
      expect(closed.ok ? closed.value : closed.error.message).toEqual({
        target_state: "unknown",
      });
      expect(manager.status(started.value.session_id).ok).toBe(false);
    });

    it("reports OpenOCD's own diagnostics when it exits during startup", async () => {
      const directory = await temporaryDirectory("rea-openocd-fail-");
      await mkdir(join(directory, "target"));
      await writeFile(join(directory, "target", "missing.cfg"), "# present\n");
      const manager = new OpenOcdSessionManager({
        environment: {
          REA_OPENOCD_COMMAND: await writeFakeOpenOcd(directory),
          REA_OPENOCD_SCRIPT_ROOTS: directory,
          FAKE_OPENOCD_FAIL: "1",
        },
      });
      const startedAt = Date.now();
      const started = await manager.start({
        configFiles: ["target/missing.cfg"],
        tclPort: await freePort(),
      });
      expect(started.ok).toBe(false);
      if (!started.ok) {
        expect(started.error.message).toContain("exited before opening");
        expect(started.error.message).toContain(
          "Can't find target/missing.cfg",
        );
      }
      // An exit is noticed at once rather than after the 20 s startup deadline.
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    });
  },
);
