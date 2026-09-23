/**
 * Unix socket protocol: client writes one line (`toggle` | `status` | `cancel`), server
 * replies with one line (`ok`, the state name, or `error …`) and closes.
 */
import { join } from "@std/path";

export type ControlCommand = "toggle" | "status" | "cancel";

export interface ControlHandlers {
  toggle(): Promise<void> | void;
  cancel(): Promise<void> | void;
  status(): string;
}

export class AlreadyRunningError extends Error {
  override name = "AlreadyRunningError";
}

export function socketPath(): string {
  if (Deno.build.os === "darwin") {
    return join(Deno.env.get("HOME") ?? "/tmp", "Library", "Caches", "deno-asr.sock");
  }
  return join(Deno.env.get("XDG_RUNTIME_DIR") ?? "/tmp", "deno-asr.sock");
}

async function isAlive(path: string): Promise<boolean> {
  try {
    const conn = await Deno.connect({ transport: "unix", path });
    conn.close();
    return true;
  } catch {
    return false;
  }
}

async function readLine(conn: Deno.Conn, max = 256): Promise<string> {
  const buf = new Uint8Array(max);
  let len = 0;
  while (len < max) {
    const n = await conn.read(buf.subarray(len));
    if (n === null) break;
    len += n;
    if (buf.subarray(0, len).includes(10)) break;
  }
  return new TextDecoder().decode(buf.subarray(0, len)).split("\n")[0].trim();
}

/**
 * Line-based control socket (`toggle` / `cancel` / `status`). Doubles as the
 * single-instance lock: throws `AlreadyRunningError` if another instance answers.
 */
export async function startControlServer(
  handlers: ControlHandlers,
  path = socketPath(),
): Promise<{ path: string; close(): void }> {
  if (await isAlive(path)) {
    throw new AlreadyRunningError(`another deno-asr instance is running (${path})`);
  }
  try {
    await Deno.remove(path);
  } catch {
    // no stale socket
  }

  const listener = Deno.listen({ transport: "unix", path });
  await Deno.chmod(path, 0o600);

  (async () => {
    for await (const conn of listener) {
      (async () => {
        try {
          const cmd = await readLine(conn) as ControlCommand;
          // Empty = liveness probe from another instance (connect + close).
          if (!cmd) return;
          let reply: string;
          switch (cmd) {
            case "toggle":
              await handlers.toggle();
              reply = "ok";
              break;
            case "cancel":
              await handlers.cancel();
              reply = "ok";
              break;
            case "status":
              reply = handlers.status();
              break;
            default:
              reply = `error unknown command '${cmd}'`;
          }
          await conn.write(new TextEncoder().encode(reply + "\n"));
        } catch (err) {
          console.error(`[control] ${err}`);
        } finally {
          try {
            conn.close();
          } catch {
            // already closed
          }
        }
      })();
    }
  })().catch(() => {});

  return {
    path,
    close() {
      try {
        listener.close();
      } catch {
        // already closed
      }
      try {
        Deno.removeSync(path);
      } catch {
        // already removed
      }
    },
  };
}

export async function sendControl(cmd: ControlCommand, path = socketPath()): Promise<string> {
  const conn = await Deno.connect({ transport: "unix", path });
  try {
    await conn.write(new TextEncoder().encode(cmd + "\n"));
    return await readLine(conn, 4096);
  } finally {
    conn.close();
  }
}
