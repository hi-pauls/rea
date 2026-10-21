import { createConnection, type Socket } from "node:net";

/**
 * OpenOCD's TCL RPC frames every request and every reply with SUB (0x1a), and
 * answers requests strictly in order, so a FIFO of waiters matches replies to
 * commands without any request identifier in the protocol itself.
 */
const TERMINATOR = "\u001a";
const DEFAULT_REPLY_LIMIT_BYTES = 1024 * 1024;

export interface OpenOcdTclReply {
  readonly text: string;
  readonly truncated: boolean;
}

interface ReplyWaiter {
  readonly resolve: (reply: OpenOcdTclReply) => void;
  readonly reject: (cause: Error) => void;
  /** Set once the caller has its answer; the late reply is then discarded. */
  settled: boolean;
}

/** @internal Pure split of a received chunk into complete frames and a tail. */
export const splitOpenOcdFrames = (
  buffered: string,
): { readonly frames: readonly string[]; readonly tail: string } => {
  const parts = buffered.split(TERMINATOR);
  return { frames: parts.slice(0, -1), tail: parts.at(-1) ?? "" };
};

export class OpenOcdTclClient {
  readonly #socket: Socket;
  readonly #replyLimitBytes: number;
  readonly #waiters: ReplyWaiter[] = [];
  #tail = "";
  #failure: Error | undefined;

  private constructor(socket: Socket, replyLimitBytes: number) {
    this.#socket = socket;
    this.#replyLimitBytes = replyLimitBytes;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.#receive(chunk));
    socket.on("error", (cause: Error) => this.#fail(cause));
    socket.on("close", () =>
      this.#fail(new Error("The OpenOCD TCL connection closed.")),
    );
  }

  static async connect(options: {
    readonly port: number;
    readonly host?: string;
    readonly timeoutMs: number;
    readonly replyLimitBytes?: number;
  }): Promise<OpenOcdTclClient> {
    return new Promise<OpenOcdTclClient>((resolve, reject) => {
      const socket = createConnection({
        port: options.port,
        host: options.host ?? "127.0.0.1",
      });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new Error(
            `OpenOCD did not accept a TCL connection on port ${String(options.port)} within ${String(options.timeoutMs)} ms.`,
          ),
        );
      }, options.timeoutMs);
      timer.unref();
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.removeAllListeners("error");
        resolve(
          new OpenOcdTclClient(
            socket,
            options.replyLimitBytes ?? DEFAULT_REPLY_LIMIT_BYTES,
          ),
        );
      });
      socket.once("error", (cause: Error) => {
        clearTimeout(timer);
        reject(cause);
      });
    });
  }

  async send(command: string, timeoutMs: number): Promise<OpenOcdTclReply> {
    if (this.#failure !== undefined) throw this.#failure;
    if (command.includes(TERMINATOR))
      throw new Error(
        "An OpenOCD TCL command cannot contain the protocol terminator.",
      );
    return new Promise<OpenOcdTclReply>((resolve, reject) => {
      // A timed-out waiter stays queued as a placeholder: OpenOCD still answers
      // the command eventually, and removing the waiter would hand that late
      // reply to the next command.
      const waiter: ReplyWaiter = {
        settled: false,
        resolve: (reply) => {
          clearTimeout(timer);
          if (!waiter.settled) resolve(reply);
          waiter.settled = true;
        },
        reject: (cause) => {
          clearTimeout(timer);
          if (!waiter.settled) reject(cause);
          waiter.settled = true;
        },
      };
      const timer = setTimeout(() => {
        waiter.settled = true;
        reject(
          new Error(
            `OpenOCD did not answer the TCL command within ${String(timeoutMs)} ms.`,
          ),
        );
      }, timeoutMs);
      timer.unref();
      this.#waiters.push(waiter);
      this.#socket.write(`${command}${TERMINATOR}`, (cause) => {
        if (cause) this.#fail(cause);
      });
    });
  }

  close(): void {
    this.#socket.destroy();
    this.#fail(new Error("The OpenOCD TCL connection was closed by REA."));
  }

  #receive(chunk: string): void {
    const { frames, tail } = splitOpenOcdFrames(`${this.#tail}${chunk}`);
    for (const frame of frames) {
      const waiter = this.#waiters.shift();
      waiter?.resolve({
        text: frame.slice(0, this.#replyLimitBytes),
        truncated: frame.length > this.#replyLimitBytes,
      });
    }
    if (tail.length > this.#replyLimitBytes) {
      this.#tail = "";
      this.#waiters.shift()?.resolve({
        text: tail.slice(0, this.#replyLimitBytes),
        truncated: true,
      });
    } else this.#tail = tail;
  }

  #fail(cause: Error): void {
    this.#failure ??= cause;
    while (this.#waiters.length > 0) this.#waiters.shift()?.reject(cause);
  }
}
