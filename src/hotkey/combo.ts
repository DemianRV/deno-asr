/**
 * Hotkey combos use the `global-hotkey` accelerator format:
 * modifiers (`CmdOrCtrl`, `Super`, `Ctrl`, `Alt`, `Shift`) + a W3C `KeyboardEvent.code`.
 */

export type Modifier = "CmdOrCtrl" | "Super" | "Ctrl" | "Alt" | "Shift";

export interface Combo {
  mods: Modifier[];
  code: string;
}

const MOD_ALIASES: Record<string, Modifier> = {
  CMDORCTRL: "CmdOrCtrl",
  CMDORCONTROL: "CmdOrCtrl",
  COMMANDORCONTROL: "CmdOrCtrl",
  COMMANDORCTRL: "CmdOrCtrl",
  SUPER: "Super",
  CMD: "Super",
  COMMAND: "Super",
  META: "Super",
  CTRL: "Ctrl",
  CONTROL: "Ctrl",
  ALT: "Alt",
  OPTION: "Alt",
  SHIFT: "Shift",
};

const MOD_ORDER: Modifier[] = ["CmdOrCtrl", "Super", "Ctrl", "Alt", "Shift"];

/** `KeyboardEvent.code` → GNOME keysym name, for every code `global-hotkey` accepts. */
const CODE_TO_KEYSYM: Record<string, string> = {
  Space: "space",
  Enter: "Return",
  Tab: "Tab",
  Escape: "Escape",
  Backspace: "BackSpace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "Page_Up",
  PageDown: "Page_Down",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Backquote: "grave",
  Minus: "minus",
  Equal: "equal",
  BracketLeft: "bracketleft",
  BracketRight: "bracketright",
  Backslash: "backslash",
  Semicolon: "semicolon",
  Quote: "apostrophe",
  Comma: "comma",
  Period: "period",
  Slash: "slash",
  Pause: "Pause",
  PrintScreen: "Print",
  ScrollLock: "Scroll_Lock",
  NumLock: "Num_Lock",
  CapsLock: "Caps_Lock",
};
for (let i = 0; i < 26; i++) {
  const ch = String.fromCharCode(65 + i);
  CODE_TO_KEYSYM[`Key${ch}`] = ch.toLowerCase();
}
for (let i = 0; i <= 9; i++) {
  CODE_TO_KEYSYM[`Digit${i}`] = String(i);
  CODE_TO_KEYSYM[`Numpad${i}`] = `KP_${i}`;
}
for (let i = 1; i <= 24; i++) CODE_TO_KEYSYM[`F${i}`] = `F${i}`;

export const SUPPORTED_CODES: ReadonlySet<string> = new Set(Object.keys(CODE_TO_KEYSYM));

export function parseCombo(input: string): Combo {
  const tokens = input.split("+").map((t) => t.trim()).filter(Boolean);
  if (tokens.length < 2) {
    throw new Error(`hotkey needs at least one modifier and a key: '${input}'`);
  }

  const code = tokens.pop()!;
  if (!SUPPORTED_CODES.has(code)) throw new Error(`unsupported key '${code}'`);

  const mods = new Set<Modifier>();
  for (const t of tokens) {
    const mod = MOD_ALIASES[t.toUpperCase()];
    if (!mod) throw new Error(`unknown modifier '${t}'`);
    mods.add(mod);
  }
  return { mods: MOD_ORDER.filter((m) => mods.has(m)), code };
}

export function formatCombo(combo: Combo): string {
  return [...combo.mods, combo.code].join("+");
}

export function normalizeCombo(input: string): string {
  return formatCombo(parseCombo(input));
}

/** GNOME accelerator, e.g. `<Primary><Shift>space`. */
export function toGnome(input: string): string {
  const { mods, code } = parseCombo(input);
  const map: Record<Modifier, string> = {
    CmdOrCtrl: "<Primary>",
    Ctrl: "<Primary>",
    Super: "<Super>",
    Alt: "<Alt>",
    Shift: "<Shift>",
  };
  const prefix = [...new Set(mods.map((m) => map[m]))].join("");
  return prefix + CODE_TO_KEYSYM[code];
}

function keyLabel(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  const labels: Record<string, string> = {
    Space: "Espacio",
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    Backquote: "`",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
  };
  return labels[code] ?? code;
}

/** Human label: `⌘⇧Espacio` on macOS, `Ctrl+Shift+Espacio` elsewhere. */
export function displayCombo(input: string, os: typeof Deno.build.os = Deno.build.os): string {
  const { mods, code } = parseCombo(input);
  if (os === "darwin") {
    const sym: Record<Modifier, string> = {
      CmdOrCtrl: "⌘",
      Super: "⌘",
      Ctrl: "⌃",
      Alt: "⌥",
      Shift: "⇧",
    };
    // macOS convention: ⌃⌥⇧⌘
    const order: Modifier[] = ["Ctrl", "Alt", "Shift", "CmdOrCtrl", "Super"];
    const s = [...new Set(order.filter((m) => mods.includes(m)).map((m) => sym[m]))].join("");
    return s + keyLabel(code);
  }
  const names: Record<Modifier, string> = {
    CmdOrCtrl: "Ctrl",
    Ctrl: "Ctrl",
    Super: "Super",
    Alt: "Alt",
    Shift: "Shift",
  };
  return [...new Set(mods.map((m) => names[m])), keyLabel(code)].join("+");
}
