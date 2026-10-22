import { createConnection, type Socket } from "node:net";

/**
 * SCPI over a raw TCP socket (port 5025 on Rohde & Schwarz instruments): each
 * command is a line, each query reply is a line, except a definite-length block
 * "#<digits><length><bytes>" that carries binary data and may contain newlines.
 * A refused query is never answered, so a missing reply ends in a timeout.
 */
const MAX_REPLY_BYTES = 128 * 1024 * 1024;

/** @internal Pure split of buffered bytes into one reply line and the rest. */
export const takeScpiLine = (
  buffered: Buffer,
): { readonly line: string; readonly rest: Buffer } | undefined => {
  const end = buffered.indexOf(0x0a);
  return end < 0
    ? undefined
    : {
        line: buffered.subarray(0, end).toString("latin1").replace(/\r$/u, ""),
        rest: buffered.subarray(end + 1),
      };
};

/** @internal Pure split of buffered bytes into one definite-length block and the rest. */
export const takeScpiBlock = (
  buffered: Buffer,
): { readonly block: Buffer; readonly rest: Buffer } | undefined => {
  if (buffered.length < 2) return undefined;
  if (buffered[0] !== 0x23)
    throw new Error(
      `The instrument answered with ${JSON.stringify(buffered.subarray(0, 40).toString("latin1"))} where a #-block was expected.`,
    );
  const digits = Number(String.fromCharCode(buffered[1] ?? 0));
  if (!Number.isInteger(digits) || digits < 1)
    throw new Error(
      "The instrument sent an indefinite-length block, which REA does not read.",
    );
  if (buffered.length < 2 + digits) return undefined;
  const length = Number(buffered.subarray(2, 2 + digits).toString("latin1"));
  const start = 2 + digits;
  if (buffered.length < start + length) return undefined;
  const after = buffered.subarray(start + length);
  // The block is followed by the line terminator, which may still be in flight.
  if (after.length === 0) return undefined;
  return {
    block: buffered.subarray(start, start + length),
    rest: after[0] === 0x0a ? after.subarray(1) : after,
  };
};

export class ScpiSocketClient {
  readonly #socket: Socket;
  #buffer: Buffer = Buffer.alloc(0);
  #failure: Error | undefined;
  #notify: (() => void) | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(socket: Socket) {
    this.#socket = socket;
    socket.on("data", (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      if (this.#buffer.length > MAX_REPLY_BYTES)
        this.#fail(
          new Error("The instrument sent a reply larger than REA retains."),
        );
      this.#notify?.();
    });
    socket.on("error", (cause: Error) => this.#fail(cause));
    socket.on("close", () =>
      this.#fail(new Error("The instrument closed the SCPI connection.")),
    );
  }

  static async connect(options: {
    readonly host: string;
    readonly port: number;
    readonly timeoutMs: number;
  }): Promise<ScpiSocketClient> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({
        host: options.host,
        port: options.port,
      });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new Error(
            `The instrument did not accept a connection on ${options.host}:${String(options.port)} within ${String(options.timeoutMs)} ms.`,
          ),
        );
      }, options.timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.removeAllListeners("error");
        resolve(new ScpiSocketClient(socket));
      });
      socket.once("error", (cause: Error) => {
        clearTimeout(timer);
        reject(cause);
      });
    });
  }

  get closed(): boolean {
    return this.#failure !== undefined;
  }

  /** Sends a command that has no reply. */
  async send(text: string): Promise<void> {
    return this.#serialized(async () => this.#write(text));
  }

  async query(text: string, timeoutMs: number): Promise<string> {
    return this.#serialized(async () => {
      await this.#write(text);
      return this.#next(takeScpiLine, timeoutMs, text).then(
        (taken) => taken.line,
      );
    });
  }

  async queryBlock(text: string, timeoutMs: number): Promise<Buffer> {
    return this.#serialized(async () => {
      await this.#write(text);
      return this.#next(takeScpiBlock, timeoutMs, text).then(
        (taken) => taken.block,
      );
    });
  }

  close(): void {
    this.#socket.destroy();
    this.#fail(new Error("The SCPI connection was closed by REA."));
  }

  async #serialized<Value>(run: () => Promise<Value>): Promise<Value> {
    const queued = this.#queue.then(run);
    this.#queue = queued.catch(() => undefined);
    return queued;
  }

  async #write(text: string): Promise<void> {
    if (this.#failure !== undefined) throw this.#failure;
    if (/[\r\n]/u.test(text))
      throw new Error("An SCPI command cannot contain a line break.");
    await new Promise<void>((resolve, reject) =>
      this.#socket.write(`${text}\n`, (cause) =>
        cause ? reject(cause) : resolve(),
      ),
    );
  }

  async #next<Taken extends { readonly rest: Buffer }>(
    take: (buffered: Buffer) => Taken | undefined,
    timeoutMs: number,
    query: string,
  ): Promise<Taken> {
    const deadline = Date.now() + timeoutMs;
    let taken = take(this.#buffer);
    while (taken === undefined) {
      if (this.#failure !== undefined) throw this.#failure;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        // A late answer would be read as the reply to the next query.
        const timedOut = new Error(
          `The instrument did not answer ${JSON.stringify(query)} within ${String(timeoutMs)} ms; it does not answer a query it rejects.`,
        );
        this.close();
        throw timedOut;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.#notify = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.#notify = undefined;
      taken = take(this.#buffer);
    }
    this.#buffer = taken.rest;
    return taken;
  }

  #fail(cause: Error): void {
    this.#failure ??= cause;
    this.#notify?.();
  }
}
