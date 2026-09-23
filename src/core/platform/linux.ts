import { CommandMissingError, run, runOk, spawnDetached, typeTimeoutMs } from "./exec.ts";
import type { Platform, SoundKind } from "./types.ts";
import { ensureSounds } from "../sounds.ts";

export function isWayland(env: Pick<typeof Deno.env, "get"> = Deno.env): boolean {
  return env.get("XDG_SESSION_TYPE")?.toLowerCase() === "wayland" || !!env.get("WAYLAND_DISPLAY");
}

export function isGnome(env: Pick<typeof Deno.env, "get"> = Deno.env): boolean {
  return (env.get("XDG_CURRENT_DESKTOP") ?? "").toUpperCase().split(":").includes("GNOME");
}

// Fallback if the generated tones can't be written.
const SOUND_DIR = "/usr/share/sounds/freedesktop/stereo";
const SYSTEM_SOUNDS: Record<SoundKind, string> = {
  start: `${SOUND_DIR}/message.oga`,
  stop: `${SOUND_DIR}/complete.oga`,
  error: `${SOUND_DIR}/dialog-error.oga`,
};
let sounds: Record<SoundKind, string> = SYSTEM_SOUNDS;

// Linux input-event-codes: KEY_LEFTCTRL=29, KEY_LEFTSHIFT=42, KEY_V=47.
const YDOTOOL_KEYS = {
  "ctrl+v": ["29:1", "47:1", "47:0", "29:0"],
  "ctrl+shift+v": ["29:1", "42:1", "47:1", "47:0", "42:0", "29:0"],
};

function hint(err: unknown, pkg: string): never {
  if (err instanceof CommandMissingError) {
    throw new Error(`${err.message} (sudo apt install ${pkg})`);
  }
  throw err;
}

export const linux: Platform = {
  name: "linux",

  async init() {
    try {
      sounds = await ensureSounds();
    } catch (err) {
      console.error(`[deno-asr] no se pudieron generar los sonidos, uso los del sistema: ${err}`);
    }
  },

  async copy(text) {
    try {
      // Both stay in the background to own the selection: never pipe their stdout/stderr.
      const opts = { stdin: text, detachOutput: true, timeoutMs: 3_000 };
      if (isWayland()) await runOk("wl-copy", [], opts);
      else await runOk("xclip", ["-selection", "clipboard"], opts);
    } catch (err) {
      hint(err, isWayland() ? "wl-clipboard" : "xclip");
    }
  },

  async readClipboard() {
    try {
      const res = isWayland()
        ? await run("wl-paste", ["--no-newline"], { timeoutMs: 2_000 })
        : await run("xclip", ["-selection", "clipboard", "-o"], { timeoutMs: 2_000 });
      return res.code === 0 ? res.stdout : null;
    } catch {
      return null;
    }
  },

  async paste(keys) {
    try {
      const opts = { timeoutMs: 5_000 };
      if (isWayland()) await runOk("ydotool", ["key", ...YDOTOOL_KEYS[keys]], opts);
      else await runOk("xdotool", ["key", "--clearmodifiers", keys], opts);
    } catch (err) {
      hint(err, isWayland() ? "ydotool" : "xdotool");
    }
  },

  async typeText(text) {
    try {
      const opts = { timeoutMs: typeTimeoutMs(text) };
      if (isWayland()) await runOk("ydotool", ["type", "--", text], opts);
      else await runOk("xdotool", ["type", "--clearmodifiers", "--", text], opts);
    } catch (err) {
      hint(err, isWayland() ? "ydotool" : "xdotool");
    }
  },

  playSound(kind) {
    spawnDetached("sh", [
      "-c",
      `pw-play "$0" 2>/dev/null || paplay "$0" 2>/dev/null || aplay -q "$0" 2>/dev/null`,
      sounds[kind],
    ], `sound ${kind}`);
  },

  async notify(title, body) {
    try {
      await run("notify-send", ["--app-name=Deno ASR", title, body], { timeoutMs: 5_000 });
    } catch {
      // libnotify-bin missing: ignore
    }
  },

  async pickFolder(prompt) {
    try {
      const res = await run(
        "zenity",
        ["--file-selection", "--directory", `--title=${prompt}`],
        { timeoutMs: 0 },
      );
      return res.code === 0 ? res.stdout.trim() : null;
    } catch (err) {
      hint(err, "zenity");
    }
  },

  async openPath(path) {
    await runOk("xdg-open", [path]);
  },
};
