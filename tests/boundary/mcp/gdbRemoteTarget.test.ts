import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { AnalysisInputError } from "../../../src/domain/analysisErrorCore.js";
import { GdbSessionManager } from "../../../src/gdb/GdbSessionManager.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

// Answers only what a remote attach needs, so an unmodelled command fails the
// test instead of passing silently.
const writeFakeGdb = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "rea-gdb-remote-"));
  directories.push(directory);
  const provider = join(directory, "fake-gdb.mjs");
  await writeFile(
    provider,
    `#!${process.execPath}
import { createInterface } from 'node:readline';
let connected = false;
process.stdout.write('(gdb)\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const token = /^(\\d+)/.exec(line)?.[1];
  if (!token) return;
  const command = line.slice(token.length);
  let result = 'error,msg="Unmodeled fixture command"';
  if (command === '-gdb-set auto-load off') result = 'done';
  else if (command === '-target-select extended-remote :3333') {
    connected = true;
    result = 'connected';
  }
  else if (command === '-list-thread-groups --recurse 1')
    result = connected
      ? 'done,groups=[{id="i1",type="process",pid="4242"}]'
      : 'done,groups=[]';
  else if (command === '-target-disconnect') {
    connected = false;
    result = 'done';
  }
  else if (command === '-gdb-exit') result = 'done';
  process.stdout.write(token + '^' + result + '\\n(gdb)\\n', () => {
    if (command === '-gdb-exit') process.exit(0);
  });
});
`,
  );
  await chmod(provider, 0o700);
  return provider;
};

it.each(["darwin", "win32"] as const)(
  "refuses a local-inferior GDB session on %s and names the remote alternative",
  async (platform) => {
    const manager = new GdbSessionManager({ platform, environment: {} });
    const started = await manager.start();
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.error.message).toContain("remote_target");
  },
);

it("refuses an inferior TTY alongside a remote target", async () => {
  const manager = new GdbSessionManager({
    platform: "linux",
    environment: {},
  });
  const started = await manager.start(undefined, {
    remoteTarget: ":3333",
    inferiorTty: "/dev/pts/9",
  });
  expect(started.ok).toBe(false);
  if (!started.ok) {
    expect(started.error).toBeInstanceOf(AnalysisInputError);
    const [issue] = (started.error as AnalysisInputError).issues;
    expect(issue?.path).toEqual(["inferior_tty"]);
    expect(issue?.message).toContain("runs no local inferior");
  }
});

it("refuses a remote target that is not a bare host, port or device path", async () => {
  const manager = new GdbSessionManager({
    platform: "linux",
    environment: {},
  });
  const started = await manager.start(undefined, {
    remoteTarget: ":3333 -ex kill",
  });
  expect(started.ok).toBe(false);
  if (!started.ok) {
    expect(started.error).toBeInstanceOf(AnalysisInputError);
    const [issue] = (started.error as AnalysisInputError).issues;
    expect(issue?.path).toEqual(["remote_target"]);
    expect(issue?.message).toContain("without whitespace");
  }
});

it("refuses the embedded debugger when no cross debugger is configured", async () => {
  const manager = new GdbSessionManager({
    platform: "linux",
    environment: {},
  });
  const started = await manager.start(undefined, {
    remoteTarget: ":3333",
    debuggerSelection: "embedded",
  });
  expect(started.ok).toBe(false);
  if (!started.ok)
    expect(started.error.message).toContain("REA_GDB_EMBEDDED_COMMAND");
});

it.skipIf(process.platform === "win32").each(["darwin", "win32"] as const)(
  "attaches to a remote GDB server on %s and disconnects on close",
  async (platform) => {
    const provider = await writeFakeGdb();
    const manager = new GdbSessionManager({
      platform,
      environment: { REA_GDB_COMMAND: provider },
    });
    const started = await manager.start(undefined, { remoteTarget: ":3333" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    // The server reports a live thread group and no inferior TTY is verified,
    // so a local session would refuse this close.
    const closed = await manager.close(started.value.session_id);
    expect(closed.ok ? "closed" : closed.error.message).toBe("closed");
    if (closed.ok) expect(closed.value.target_state).toBe("unknown");
  },
);

it.skipIf(process.platform === "win32")(
  "runs the configured cross debugger for an embedded remote target",
  async () => {
    const provider = await writeFakeGdb();
    const manager = new GdbSessionManager({
      platform: "darwin",
      environment: {
        REA_GDB_COMMAND: "/nonexistent/host-gdb",
        REA_GDB_EMBEDDED_COMMAND: provider,
      },
    });
    const started = await manager.start(undefined, {
      remoteTarget: ":3333",
      debuggerSelection: "embedded",
    });
    expect(started.ok).toBe(true);
    if (started.ok) await manager.close(started.value.session_id);
  },
);
