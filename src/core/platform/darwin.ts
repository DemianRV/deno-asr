import { run, runOk, spawnDetached, typeTimeoutMs } from "./exec.ts";
import type { Platform, SoundKind } from "./types.ts";
import { ensureSounds } from "../sounds.ts";

// pbcopy/pbpaste pick the text encoding from the locale; force UTF-8.
const UTF8 = { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };

// Fallback if the generated tones can't be written.
const SYSTEM_SOUNDS: Record<SoundKind, string> = {
  start: "/System/Library/Sounds/Tink.aiff",
  stop: "/System/Library/Sounds/Pop.aiff",
  error: "/System/Library/Sounds/Basso.aiff",
};
let sounds: Record<SoundKind, string> = SYSTEM_SOUNDS;

// TCC attributes the check to the responsible app (DenoASR.app, or the terminal in dev).
const AX_CHECK = 'ObjC.import("ApplicationServices"); $.AXIsProcessTrusted()';
// osascript is a platform binary, so TCC never shows the Accessibility prompt for it.
const AX_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
let axTrusted = false;
let axSettingsOpened = false;

/**
 * Without Accessibility, System Events drops the keystrokes and osascript still exits 0,
 * so check up front. A stale grant (re-signed build) also reads as untrusted.
 */
async function assertAccessibility(): Promise<void> {
  if (axTrusted) return;
  const res = await run("osascript", ["-l", "JavaScript", "-e", AX_CHECK]);
  if (res.code !== 0) return; // can't tell: try anyway
  axTrusted = res.stdout.trim() === "true";
  if (axTrusted) return;
  if (!axSettingsOpened) {
    axSettingsOpened = true;
    spawnDetached("open", [AX_SETTINGS], "accessibility settings");
  }
  throw new Error("activa Deno ASR en Ajustes → Privacidad y seguridad → Accesibilidad");
}

/** AppleScript string literal. */
export function asString(s: string): string {
  return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export const darwin: Platform = {
  name: "macos",

  async init() {
    try {
      sounds = await ensureSounds();
    } catch (err) {
      console.error(`[deno-asr] no se pudieron generar los sonidos, uso los del sistema: ${err}`);
    }
  },

  async copy(text) {
    await runOk("pbcopy", [], { stdin: text, env: UTF8 });
  },

  async readClipboard() {
    const res = await run("pbpaste", [], { env: UTF8 });
    return res.code === 0 ? res.stdout : null;
  },

  async paste() {
    await assertAccessibility();
    await runOk("osascript", [
      "-e",
      'tell application "System Events" to keystroke "v" using command down',
    ]);
  },

  async typeText(text) {
    await assertAccessibility();
    await runOk("osascript", [
      "-e",
      `tell application "System Events" to keystroke ${asString(text)}`,
    ], { timeoutMs: typeTimeoutMs(text) });
  },

  playSound(kind) {
    spawnDetached("afplay", [sounds[kind]], `sound ${kind}`);
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
    ], { timeoutMs: 0 });
    if (res.code !== 0) return null; // user cancelled
    const path = res.stdout.trim();
    return path.length > 1 ? path.replace(/\/$/, "") : path;
  },

  async openPath(path) {
    await runOk("open", [path]);
  },
};
