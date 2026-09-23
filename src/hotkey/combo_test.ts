import { assertEquals, assertThrows } from "@std/assert";
import { displayCombo, normalizeCombo, parseCombo, toGnome } from "./combo.ts";

Deno.test("parseCombo orders modifiers and accepts aliases", () => {
  assertEquals(parseCombo("shift+cmdorctrl+Space"), {
    mods: ["CmdOrCtrl", "Shift"],
    code: "Space",
  });
  assertEquals(normalizeCombo("Alt + Ctrl + KeyR"), "Ctrl+Alt+KeyR");
});

Deno.test("parseCombo rejects bad input", () => {
  assertThrows(() => parseCombo("Space"), Error, "at least one modifier");
  assertThrows(() => parseCombo("Ctrl+Hyper+KeyA"), Error, "unknown modifier");
  assertThrows(() => parseCombo("Ctrl+NotAKey"), Error, "unsupported key");
});

Deno.test("toGnome maps to GTK accelerators", () => {
  assertEquals(toGnome("CmdOrCtrl+Shift+Space"), "<Primary><Shift>space");
  assertEquals(toGnome("Super+Alt+KeyD"), "<Super><Alt>d");
  assertEquals(toGnome("Ctrl+CmdOrCtrl+F12"), "<Primary>F12");
});

Deno.test("displayCombo per OS", () => {
  assertEquals(displayCombo("CmdOrCtrl+Shift+Space", "darwin"), "⇧⌘Espacio");
  assertEquals(displayCombo("Ctrl+Alt+Shift+F12", "darwin"), "⌃⌥⇧F12");
  assertEquals(displayCombo("CmdOrCtrl+Shift+Space", "linux"), "Ctrl+Shift+Espacio");
  assertEquals(displayCombo("Super+Digit1", "linux"), "Super+1");
});
