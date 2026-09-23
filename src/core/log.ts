/**
 * Opt-in debug logging.
 *
 * - `ASR_DEBUG`: `*` / `1` for everything, or a comma list of namespaces
 *   (`exec,controller,helper,desktop,control`). Unset = every logger is a no-op.
 * - `ASR_DEBUG_FILE`: also append each line to this file. Writes are synchronous so the
 *   last line survives a frozen event loop.
 */

export type DebugFn = (...args: unknown[]) => void;

export function parseDebugSpec(value: string | undefined): string[] {
  return (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function envGet(key: string): string | undefined {
  try {
    return Deno.env.get(key);
  } catch {
    // no --allow-env
    return undefined;
  }
}

const SPEC = parseDebugSpec(envGet("ASR_DEBUG"));
const FILE = envGet("ASR_DEBUG_FILE") || undefined;
const T0 = performance.now();

export function debugEnabled(ns: string, spec: string[] = SPEC): boolean {
  return spec.includes("*") || spec.includes("1") || spec.includes(ns);
}

export function formatDebugLine(ns: string, args: unknown[]): string {
  const msg = args
    .map((a) => typeof a === "string" ? a : Deno.inspect(a, { depth: 4, colors: false }))
    .join(" ");
  return `${new Date().toISOString()} +${Math.round(performance.now() - T0)}ms [${ns}] ${msg}`;
}

export function debug(
  ns: string,
  opts: { spec?: string[]; file?: string } = {},
): DebugFn {
  if (!debugEnabled(ns, opts.spec ?? SPEC)) return () => {};
  const file = opts.file ?? FILE;
  return (...args) => {
    const line = formatDebugLine(ns, args);
    console.error(line);
    if (file) {
      try {
        Deno.writeTextFileSync(file, line + "\n", { append: true });
      } catch {
        // debug output is best effort
      }
    }
  };
}

/** Shortens user text for logs. */
export function clip(s: string, n = 40): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
