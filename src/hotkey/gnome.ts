/**
 * Global hotkey for GNOME on Wayland, where apps can't grab keys: a custom keybinding
 * (visible in Settings → Keyboard) that pings the control socket with `toggle`.
 */
import { run, runOk } from "../core/platform/exec.ts";
import { toGnome } from "./combo.ts";

const SCHEMA = "org.gnome.settings-daemon.plugins.media-keys";
const LIST_KEY = "custom-keybindings";
const ENTRY_PATH = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/deno-asr/";
const ENTRY_SCHEMA = `${SCHEMA}.custom-keybinding:${ENTRY_PATH}`;

/** GVariant string literal. */
export function gvString(s: string): string {
  return `'${s.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

/** Parses `gsettings get` output for an `as` value: `@as []` or `['/a/', '/b/']`. */
export function parseStringArray(output: string): string[] {
  return [...output.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replaceAll("\\'", "'"));
}

export function formatStringArray(items: string[]): string {
  return items.length ? `[${items.map(gvString).join(", ")}]` : "@as []";
}

/** Command GNOME runs on the shortcut: ping the control socket. */
export function toggleCommand(socket: string): string {
  return `sh -c "printf toggle | nc -U -N ${socket}"`;
}

export async function gnomeAvailable(): Promise<boolean> {
  try {
    const res = await run("gsettings", ["list-keys", SCHEMA]);
    return res.code === 0 && res.stdout.includes(LIST_KEY);
  } catch {
    return false;
  }
}

/** Adds (or updates) our custom keybinding without touching the user's others. */
export async function registerGnomeShortcut(combo: string, socket: string): Promise<void> {
  const binding = toGnome(combo);
  const list = parseStringArray(await runOk("gsettings", ["get", SCHEMA, LIST_KEY]));
  if (!list.includes(ENTRY_PATH)) {
    await runOk("gsettings", ["set", SCHEMA, LIST_KEY, formatStringArray([...list, ENTRY_PATH])]);
  }
  await runOk("gsettings", ["set", ENTRY_SCHEMA, "name", gvString("Deno ASR: grabar/parar")]);
  await runOk("gsettings", ["set", ENTRY_SCHEMA, "command", gvString(toggleCommand(socket))]);
  await runOk("gsettings", ["set", ENTRY_SCHEMA, "binding", gvString(binding)]);
}

export async function unregisterGnomeShortcut(): Promise<void> {
  const list = parseStringArray(await runOk("gsettings", ["get", SCHEMA, LIST_KEY]));
  if (list.includes(ENTRY_PATH)) {
    await runOk("gsettings", [
      "set",
      SCHEMA,
      LIST_KEY,
      formatStringArray(list.filter((p) => p !== ENTRY_PATH)),
    ]);
  }
  await run("gsettings", ["reset-recursively", ENTRY_SCHEMA]);
}
