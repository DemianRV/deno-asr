import { CommandMissingError, run, runOk, spawnDetached } from "./exec.ts";
import type { Platform, SoundKind } from "./types.ts";

export function isWayland(env: Pick<typeof Deno.env, "get"> = Deno.env): boolean {
  return env.get("XDG_SESSION_TYPE")?.toLowerCase() === "wayland" || !!env.get("WAYLAND_DISPLAY");
}

export function isGnome(env: Pick<typeof Deno.env, "get"> = Deno.env): boolean {
  return (env.get("XDG_CURRENT_DESKTOP") ?? "").toUpperCase().split(":").includes("GNOME");
}

const SOUND_DIR = "/usr/share/sounds/freedesktop/stereo";
const SOUNDS: Record<SoundKind, string> = {
  start: `${SOUND_DIR}/message.oga`,
  stop: `${SOUND_DIR}/complete.oga`,
  error: `${SOUND_DIR}/dialog-error.oga`,
};

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

  async copy(text) {
    try {
      if (isWayland()) await runOk("wl-copy", [], { stdin: text });
      else await runOk("xclip", ["-selection", "clipboard"], { stdin: text });
    } catch (err) {
      hint(err, isWayland() ? "wl-clipboard" : "xclip");
    }
  },

  async readClipboard() {
    try {
      const res = isWayland()
        ? await run("wl-paste", ["--no-newline"])
        : await run("xclip", ["-selection", "clipboard", "-o"]);
      return res.code === 0 ? res.stdout : null;
    } catch {
      return null;
    }
  },

  async paste(keys) {
    try {
      if (isWayland()) await runOk("ydotool", ["key", ...YDOTOOL_KEYS[keys]]);
      else await runOk("xdotool", ["key", "--clearmodifiers", keys]);
    } catch (err) {
      hint(err, isWayland() ? "ydotool" : "xdotool");
    }
  },

  async typeText(text) {
    try {
      if (isWayland()) await runOk("ydotool", ["type", "--", text]);
      else await runOk("xdotool", ["type", "--clearmodifiers", "--", text]);
    } catch (err) {
      hint(err, isWayland() ? "ydotool" : "xdotool");
    }
  },

  playSound(kind) {
    spawnDetached("sh", [
      "-c",
      `pw-play "$0" 2>/dev/null || paplay "$0" 2>/dev/null`,
      SOUNDS[kind],
    ]);
  },

  async notify(title, body) {
    try {
      await run("notify-send", ["--app-name=Deno ASR", title, body]);
    } catch {
      // libnotify-bin missing: ignore
    }
  },

  async pickFolder(prompt) {
    try {
      const res = await run("zenity", ["--file-selection", "--directory", `--title=${prompt}`]);
      return res.code === 0 ? res.stdout.trim() : null;
    } catch (err) {
      hint(err, "zenity");
    }
  },

  async openPath(path) {
    await runOk("xdg-open", [path]);
  },
};
