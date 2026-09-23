export type SoundKind = "start" | "stop" | "error";

/**
 * OS integration done by shelling out to system tools. Methods throw with an install hint
 * when a required tool is missing; `playSound` and `notify` are best effort.
 */
export interface Platform {
  readonly name: "macos" | "linux";
  /** One-time setup before first use (e.g. writing the feedback tones). Never throws. */
  init?(): Promise<void>;
  copy(text: string): Promise<void>;
  /** Current clipboard text; `null` if empty, non-text or unreadable. */
  readClipboard(): Promise<string | null>;
  /** Sends the paste shortcut to the focused app. */
  paste(keys: "ctrl+v" | "ctrl+shift+v"): Promise<void>;
  /** Synthesizes keystrokes for `text` (no clipboard involved). */
  typeText(text: string): Promise<void>;
  playSound(kind: SoundKind): void;
  notify(title: string, body: string): Promise<void>;
  /** Native folder picker; `null` if cancelled. */
  pickFolder(prompt: string): Promise<string | null>;
  openPath(path: string): Promise<void>;
}
