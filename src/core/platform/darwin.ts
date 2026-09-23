import { run, runOk, spawnDetached } from "./exec.ts";
import type { Platform, SoundKind } from "./types.ts";

// pbcopy/pbpaste pick the text encoding from the locale; force UTF-8.
const UTF8 = { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };

const SOUNDS: Record<SoundKind, string> = {
  start: "/System/Library/Sounds/Tink.aiff",
  stop: "/System/Library/Sounds/Pop.aiff",
  error: "/System/Library/Sounds/Basso.aiff",
};

/** AppleScript string literal. */
export function asString(s: string): string {
  return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export const darwin: Platform = {
  name: "macos",

  async copy(text) {
    await runOk("pbcopy", [], { stdin: text, env: UTF8 });
  },

  async readClipboard() {
    const res = await run("pbpaste", [], { env: UTF8 });
    return res.code === 0 ? res.stdout : null;
  },

  async paste() {
    // Requires Accessibility permission for the app.
    await runOk("osascript", [
      "-e",
      'tell application "System Events" to keystroke "v" using command down',
    ]);
  },

  async typeText(text) {
    await runOk("osascript", [
      "-e",
      `tell application "System Events" to keystroke ${asString(text)}`,
    ]);
  },

  playSound(kind) {
    spawnDetached("afplay", [SOUNDS[kind]]);
  },

  async notify(title, body) {
    await run("osascript", [
      "-e",
      `display notification ${asString(body)} with title ${asString(title)}`,
    ]);
  },

  async pickFolder(prompt) {
    const res = await run("osascript", [
      "-e",
      `POSIX path of (choose folder with prompt ${asString(prompt)})`,
    ]);
    if (res.code !== 0) return null; // user cancelled
    const path = res.stdout.trim();
    return path.length > 1 ? path.replace(/\/$/, "") : path;
  },

  async openPath(path) {
    await runOk("open", [path]);
  },
};
