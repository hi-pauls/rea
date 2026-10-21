import { createConnection, type Socket } from "node:net";

/**
 * Saleae Logic 1.x scripting socket: every command is text ended by NUL, and
 * every reply is text ended by "ACK", or a leading "NAK" for a refused command.
 * CAPTURE is acknowledged only once the capture ends, so its "ACK" arrives
 * unannounced, ahead of the reply to whatever command follows; the client
 * therefore remembers an outstanding capture and drops that empty reply.
 */
const COMMAND_TERMINATOR = "\u0000";
const ACK = "ACK";
const NAK = "NAK";
const MAX_REPLY_CHARACTERS = 4 * 1024 * 1024;

export type SaleaeReply =
  | { readonly status: "ack"; readonly text: string }
  | { readonly status: "nak" };

/** @internal Pure split of buffered text into one reply and the remaining text. */
export const takeSaleaeReply = (
  buffered: string,
): { readonly reply: SaleaeReply; readonly rest: string } | undefined => {
  if (buffered.startsWith(NAK))
    return { reply: { status: "nak" }, rest: buffered.slice(NAK.length) };
  const end = buffered.indexOf(ACK);
  return end < 0
    ? undefined
    : {
        reply: { status: "ack", text: buffered.slice(0, end) },
        rest: buffered.slice(end + ACK.length),
      };
};

export class SaleaeSocketClient {
  readonly #socket: Socket;
  #buffer = "";
  #captureAcknowledgementPending = false;
  #failure: Error | undefined;
  #notify: (() => void) | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(socket: Socket) {
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.#buffer += chunk;
      if (this.#buffer.length > MAX_REPLY_CHARACTERS)
        this.#fail(new Error("Logic sent a reply larger than REA retains."));
      this.#notify?.();
    });
    socket.on("error", (cause: Error) => this.#fail(cause));
    socket.on("close", () =>
      this.#fail(new Error("Logic closed the scripting connection.")),
    );
  }

  static async connect(options: {
    readonly host: string;
    readonly port: number;
    readonly timeoutMs: number;
  }): Promise<SaleaeSocketClient> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({
        host: options.host,
        port: options.port,
      });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new Error(
            `Logic did not accept a scripting connection on ${options.host}:${String(options.port)} within ${String(options.timeoutMs)} ms.`,
          ),
        );
      }, options.timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.removeAllListeners("error");
        resolve(new SaleaeSocketClient(socket));
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

  /** Sends one command and waits for its reply; commands never overlap. */
  async command(text: string, timeoutMs: number): Promise<SaleaeReply> {
    const run = this.#queue.then(() => this.#exchange(text, timeoutMs));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Sends CAPTURE, whose acknowledgement arrives only when the capture ends. */
  async startCapture(): Promise<void> {
    const run = this.#queue.then(async () => {
      if (this.#failure !== undefined) throw this.#failure;
      this.#captureAcknowledgementPending = true;
      await new Promise<void>((resolve, reject) =>
        this.#socket.write(`CAPTURE${COMMAND_TERMINATOR}`, (cause) =>
          cause ? reject(cause) : resolve(),
        ),
      );
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  close(): void {
    this.#socket.destroy();
    this.#fail(new Error("The Logic scripting connection was closed by REA."));
  }

  async #exchange(text: string, timeoutMs: number): Promise<SaleaeReply> {
    if (this.#failure !== undefined) throw this.#failure;
    if (text.includes(COMMAND_TERMINATOR))
      throw new Error("A Logic command cannot contain NUL.");
    this.#socket.write(`${text}${COMMAND_TERMINATOR}`);
    const deadline = Date.now() + timeoutMs;
    let reply = await this.#next(deadline);
    // An empty acknowledgement while a capture is outstanding is the capture's;
    // a stopped capture is acknowledged ahead of STOP_CAPTURE itself.
    if (
      this.#captureAcknowledgementPending &&
      reply.status === "ack" &&
      reply.text.trim() === ""
    ) {
      this.#captureAcknowledgementPending = false;
      reply = await this.#next(deadline);
    }
    return reply;
  }

  async #next(deadline: number): Promise<SaleaeReply> {
    let taken = takeSaleaeReply(this.#buffer);
    while (taken === undefined) {
      if (this.#failure !== undefined) throw this.#failure;
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error("Logic did not answer the command in time.");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.#notify = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.#notify = undefined;
      taken = takeSaleaeReply(this.#buffer);
    }
    this.#buffer = taken.rest;
    return taken.reply;
  }

  #fail(cause: Error): void {
    this.#failure ??= cause;
    this.#notify?.();
  }
}
