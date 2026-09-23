import { assertEquals } from "@std/assert";
import { formatStringArray, gvString, parseStringArray, toggleCommand } from "./gnome.ts";

Deno.test("gsettings string arrays round-trip", () => {
  assertEquals(parseStringArray("@as []"), []);
  const out = "['/org/a/', '/org/b/']\n";
  assertEquals(parseStringArray(out), ["/org/a/", "/org/b/"]);
  assertEquals(formatStringArray([]), "@as []");
  assertEquals(parseStringArray(formatStringArray(["/x/", "it's"])), ["/x/", "it's"]);
});

Deno.test("gvString escapes quotes and backslashes", () => {
  assertEquals(gvString(`a'b\\c`), `'a\\'b\\\\c'`);
});

Deno.test("toggleCommand pings the control socket", () => {
  assertEquals(
    toggleCommand("/run/user/1000/deno-asr.sock"),
    `sh -c "printf toggle | nc -U -N /run/user/1000/deno-asr.sock"`,
  );
});
