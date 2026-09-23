/** Thin wrappers over `Deno.Command` that map a missing binary to `CommandMissingError`. */
import { clip, debug } from "../log.ts";

const dbg = debug("exec");

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  stdin?: string;
  env?: Record<string, string>;
  /**
   * Don't pipe stdout/stderr. Required for tools that fork into the background and keep
   * the inherited fds open (xclip, wl-copy): with pipes, `output()` never resolves.
   */
  detachOutput?: boolean;
  /** Kill the process and throw after this long. Default 10 s; `0` = no limit. */
  timeoutMs?: number;
}

export class CommandMissingError extends Error {
  override name = "CommandMissingError";
  constructor(readonly command: string) {
    super(`'${command}' is not installed`);
  }
}

export class CommandTimeoutError extends Error {
  override name = "CommandTimeoutError";
  constructor(readonly command: string, readonly timeoutMs: number) {
    super(`'${command}' timed out after ${timeoutMs}ms`);
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Typing tools send one key event per character; scale the limit with the text. */
export function typeTimeoutMs(text: string): number {
  return Math.max(5_000, text.length * 50);
}

export async function run(
  command: string,
  args: string[] = [],
  opts: RunOptions = {},
): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const output = opts.detachOutput ? "null" : "piped";
  const started = Date.now();
  dbg(`→ ${command}`, args.map((a) => clip(a)), opts.detachOutput ? "(detached output)" : "");

  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(command, {
      args,
      stdin: opts.stdin !== undefined ? "piped" : "null",
      stdout: output,
      stderr: output,
      env: opts.env,
    }).spawn();
  } catch (err) {
    dbg(`✗ ${command}: ${err}`);
    if (err instanceof Deno.errors.NotFound) throw new CommandMissingError(command);
    throw err;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    if (timeoutMs <= 0) return;
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      dbg(`✗ ${command} killed after ${timeoutMs}ms`);
      reject(new CommandTimeoutError(command, timeoutMs));
    }, timeoutMs);
  });

  const work = async (): Promise<RunResult> => {
    if (opts.stdin !== undefined) {
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(opts.stdin));
      await writer.close();
    }
    if (opts.detachOutput) {
      const status = await child.status;
      return { code: status.code, stdout: "", stderr: "" };
    }
    const out = await child.output();
    const dec = new TextDecoder();
    return { code: out.code, stdout: dec.decode(out.stdout), stderr: dec.decode(out.stderr) };
  };

  const pending = work();
  // After a timeout this may still reject (e.g. stdin write to a killed process).
  pending.catch(() => {});
  try {
    const res = await Promise.race([pending, timeout]);
    dbg(`← ${command} exit ${res.code} in ${Date.now() - started}ms`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** Like `run` but throws on non-zero exit. */
export async function runOk(
  command: string,
  args: string[] = [],
  opts: RunOptions = {},
): Promise<string> {
  const res = await run(command, args, opts);
  if (res.code !== 0) {
    throw new Error(
      `${command} exited with ${res.code}: ${res.stderr.trim() || res.stdout.trim()}`,
    );
  }
  return res.stdout;
}

/** Fire-and-forget, errors ignored (sounds). `label` names it in debug logs. */
export function spawnDetached(command: string, args: string[], label = command): void {
  const started = Date.now();
  dbg(`→ ${label} (${command} ${args.map((a) => clip(a, 60)).join(" ")})`);
  try {
    const child = new Deno.Command(command, {
      args,
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    child.status.then(
      (s) => dbg(`← ${label} exit ${s.code} in ${Date.now() - started}ms`),
      (err) => dbg(`✗ ${label}: ${err}`),
    );
  } catch (err) {
    // missing binary: silently skip
    dbg(`✗ ${label}: ${err}`);
  }
}

export async function which(command: string): Promise<boolean> {
  try {
    const res = await run("sh", ["-c", `command -v ${command}`]);
    return res.code === 0;
  } catch {
    return false;
  }
}
