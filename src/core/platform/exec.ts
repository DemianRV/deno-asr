/** Thin wrappers over `Deno.Command` that map a missing binary to `CommandMissingError`. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class CommandMissingError extends Error {
  override name = "CommandMissingError";
  constructor(readonly command: string) {
    super(`'${command}' is not installed`);
  }
}

export async function run(
  command: string,
  args: string[] = [],
  opts: { stdin?: string; env?: Record<string, string> } = {},
): Promise<RunResult> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(command, {
      args,
      stdin: opts.stdin !== undefined ? "piped" : "null",
      stdout: "piped",
      stderr: "piped",
      env: opts.env,
    }).spawn();
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) throw new CommandMissingError(command);
    throw err;
  }
  if (opts.stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(opts.stdin));
    await writer.close();
  }
  const out = await child.output();
  const dec = new TextDecoder();
  return { code: out.code, stdout: dec.decode(out.stdout), stderr: dec.decode(out.stderr) };
}

/** Like `run` but throws on non-zero exit. */
export async function runOk(
  command: string,
  args: string[] = [],
  opts: { stdin?: string; env?: Record<string, string> } = {},
): Promise<string> {
  const res = await run(command, args, opts);
  if (res.code !== 0) {
    throw new Error(
      `${command} exited with ${res.code}: ${res.stderr.trim() || res.stdout.trim()}`,
    );
  }
  return res.stdout;
}

/** Fire-and-forget, errors ignored (sounds). */
export function spawnDetached(command: string, args: string[]): void {
  try {
    const child = new Deno.Command(command, {
      args,
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    child.status.catch(() => {});
  } catch {
    // missing binary: silently skip
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
