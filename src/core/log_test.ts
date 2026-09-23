import { assert, assertEquals, assertMatch } from "@std/assert";
import { debug, debugEnabled, formatDebugLine, parseDebugSpec } from "./log.ts";

Deno.test("parseDebugSpec splits and trims", () => {
  assertEquals(parseDebugSpec(undefined), []);
  assertEquals(parseDebugSpec(""), []);
  assertEquals(parseDebugSpec(" exec , desktop,"), ["exec", "desktop"]);
});

Deno.test("debugEnabled: wildcard, 1, list and empty", () => {
  assert(debugEnabled("exec", ["*"]));
  assert(debugEnabled("exec", ["1"]));
  assert(debugEnabled("exec", ["controller", "exec"]));
  assert(!debugEnabled("desktop", ["controller", "exec"]));
  assert(!debugEnabled("exec", []));
});

Deno.test("formatDebugLine has timestamp, offset and namespace", () => {
  const line = formatDebugLine("exec", ["→ xclip", { code: 0 }]);
  assertMatch(line, /^\d{4}-\d\d-\d\dT[\d:.]+Z \+\d+ms \[exec\] → xclip \{ code: 0 \}$/);
});

Deno.test("debug appends lines to the file", async () => {
  const file = await Deno.makeTempFile();
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  try {
    debug("exec", { spec: ["exec"], file })("first");
    debug("exec", { spec: ["exec"], file })("second");
    debug("desktop", { spec: ["exec"], file })("ignored");
  } finally {
    console.error = orig;
    const lines = (await Deno.readTextFile(file)).trim().split("\n");
    await Deno.remove(file);
    assertEquals(lines.length, 2);
    assertMatch(lines[0], /\[exec\] first$/);
    assertMatch(lines[1], /\[exec\] second$/);
    assertEquals(errors.length, 2);
  }
});
