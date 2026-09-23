import { TextLineStream } from "@std/streams/text-line-stream";

export type HelperCommand =
  | { cmd: "start"; device?: string }
  | { cmd: "stop"; path: string }
  | { cmd: "cancel" }
  | { cmd: "set_hotkey"; combo: string }
  | { cmd: "clear_hotkey" }
  | { cmd: "pause_hotkey" }
  | { cmd: "resume_hotkey" }
  | { cmd: "list_devices" }
  | { cmd: "quit" };

export type ReadyEvent = { event: "ready"; version: string; hotkey_supported: boolean };
export type RecordingEvent = { event: "recording"; sample_rate: number; device: string };
export type SavedEvent = { event: "saved"; path: string; duration_sec: number };
export type DevicesEvent = { event: "devices"; devices: string[]; default: string | null };

export type HelperEvent =
  | ReadyEvent
  | RecordingEvent
  | SavedEvent
  | DevicesEvent
  | { event: "hotkey" }
  | { event: "cancelled" }
  | { event: "ok" }
  | { event: "error"; msg: string };

type Envelope = HelperEvent & { id?: number };

type Pending = {
  resolve: (e: HelperEvent) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class HelperError extends Error {
  override name = "HelperError";
}

export interface HelperOptions {
  /** Executable to spawn. */
  command: string;
  args?: string[];
  /** Default per-request timeout. */
  timeoutMs?: number;
  /** Relaunch the process if it exits unexpectedly. */
  restart?: boolean;
}

/**
 * Client for `asr-helper` over its JSON-lines stdio protocol.
 *
 * Events dispatched:
 * - `ready`   CustomEvent<ReadyEvent>  (after every (re)spawn)
 * - `hotkey`  Event
 * - `message` CustomEvent<HelperEvent> (unsolicited events, e.g. stream errors)
 * - `exit`    CustomEvent<{ code: number }>
 */
export class Helper extends EventTarget {
  #opts: Required<HelperOptions>;
  #child?: Deno.ChildProcess;
  #writer?: WritableStreamDefaultWriter<Uint8Array>;
  #encoder = new TextEncoder();
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #closing = false;
  #restarts = 0;
  #ready?: ReadyEvent;
  #readyWaiters: ((e: ReadyEvent) => void)[] = [];

  constructor(opts: HelperOptions) {
    super();
    this.#opts = { args: [], timeoutMs: 10_000, restart: true, ...opts };
  }

  get info(): ReadyEvent | undefined {
    return this.#ready;
  }

  /** Spawns the helper and resolves once it reports `ready`. */
  async start(timeoutMs = 10_000): Promise<ReadyEvent> {
    this.#closing = false;
    this.#spawn();
    return await this.#waitReady(timeoutMs);
  }

  #waitReady(timeoutMs: number): Promise<ReadyEvent> {
    if (this.#ready) return Promise.resolve(this.#ready);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#readyWaiters = this.#readyWaiters.filter((w) => w !== done);
        reject(new HelperError(`helper did not become ready within ${timeoutMs}ms`));
      }, timeoutMs);
      const done = (e: ReadyEvent) => {
        clearTimeout(timer);
        resolve(e);
      };
      this.#readyWaiters.push(done);
    });
  }

  #spawn() {
    this.#ready = undefined;
    let child: Deno.ChildProcess;
    try {
      child = new Deno.Command(this.#opts.command, {
        args: this.#opts.args,
        stdin: "piped",
        stdout: "piped",
        stderr: "inherit",
      }).spawn();
    } catch (err) {
      const msg = err instanceof Deno.errors.NotFound
        ? `asr-helper not found at ${this.#opts.command}`
        : `cannot spawn asr-helper: ${err}`;
      this.dispatchEvent(new CustomEvent("message", { detail: { event: "error", msg } }));
      this.#scheduleRestart();
      return;
    }

    this.#child = child;
    this.#writer = child.stdin.getWriter();
    this.#readLoop(child);
    child.status.then((status) => this.#onExit(child, status.code));
  }

  async #readLoop(child: Deno.ChildProcess) {
    const lines = child.stdout
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new TextLineStream());
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let msg: Envelope;
        try {
          msg = JSON.parse(line);
        } catch {
          console.error(`[asr-helper] invalid line: ${line}`);
          continue;
        }
        this.#handle(msg);
      }
    } catch {
      // stdout closed; exit handling happens in #onExit
    }
  }

  #handle(msg: Envelope) {
    const { id, ...event } = msg;
    const ev = event as HelperEvent;

    if (id !== undefined) {
      const pending = this.#pending.get(id);
      if (!pending) return;
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      if (ev.event === "error") pending.reject(new HelperError(ev.msg));
      else pending.resolve(ev);
      return;
    }

    switch (ev.event) {
      case "ready":
        this.#ready = ev;
        this.#restarts = 0;
        for (const w of this.#readyWaiters.splice(0)) w(ev);
        this.dispatchEvent(new CustomEvent("ready", { detail: ev }));
        break;
      case "hotkey":
        this.dispatchEvent(new Event("hotkey"));
        break;
      default:
        this.dispatchEvent(new CustomEvent("message", { detail: ev }));
    }
  }

  #onExit(child: Deno.ChildProcess, code: number) {
    if (this.#child !== child) return;
    this.#child = undefined;
    this.#writer = undefined;
    this.#ready = undefined;

    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(new HelperError(`asr-helper exited (code ${code}) before answering #${id}`));
    }
    this.#pending.clear();
    this.dispatchEvent(new CustomEvent("exit", { detail: { code } }));

    if (!this.#closing) this.#scheduleRestart();
  }

  #scheduleRestart() {
    if (this.#closing || !this.#opts.restart) return;
    const delay = Math.min(30_000, 500 * 2 ** this.#restarts++);
    setTimeout(() => {
      if (!this.#closing && !this.#child) this.#spawn();
    }, delay);
  }

  /** Sends a command and resolves with its reply. Rejects on `error` replies. */
  async request<E extends HelperEvent = HelperEvent>(
    command: HelperCommand,
    timeoutMs = this.#opts.timeoutMs,
  ): Promise<E> {
    if (!this.#writer) throw new HelperError("asr-helper is not running");
    const id = this.#nextId++;
    const reply = new Promise<HelperEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new HelperError(`asr-helper timed out on '${command.cmd}'`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
    });
    await this.#writer.write(this.#encoder.encode(JSON.stringify({ id, ...command }) + "\n"));
    return (await reply) as E;
  }

  async close() {
    this.#closing = true;
    const child = this.#child;
    if (!child) return;
    try {
      await this.request({ cmd: "quit" }, 1_000);
    } catch {
      // fall through to kill
    }
    try {
      await this.#writer?.close();
    } catch {
      // already closed
    }
    const exited = await Promise.race([
      child.status.then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), 1_000)),
    ]);
    if (!exited) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  }
}

/** `ASR_HELPER_PATH`, or `asr-helper` next to the running executable. */
export function resolveHelperPath(): string {
  const fromEnv = Deno.env.get("ASR_HELPER_PATH");
  if (fromEnv) return fromEnv;
  const exe = Deno.execPath();
  const dir = exe.slice(0, exe.lastIndexOf("/"));
  return `${dir}/asr-helper`;
}
