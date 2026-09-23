import { assert, assertEquals, assertRejects } from "@std/assert";
import { CommandMissingError, CommandTimeoutError, run, runOk } from "./exec.ts";

// Mimics xclip / wl-copy: fork a child that keeps the inherited stdout/stderr, then exit.
const FORKS_AND_LINGERS = ["-c", "sleep 1 & echo parent"];

Deno.test("run captures stdout, stderr and code", async () => {
  const res = await run("sh", ["-c", "echo out; echo err >&2; exit 3"]);
  assertEquals(res, { code: 3, stdout: "out\n", stderr: "err\n" });
});

Deno.test("run feeds stdin", async () => {
  assertEquals(await runOk("cat", [], { stdin: "hola" }), "hola");
});

Deno.test("detachOutput returns as soon as the parent exits, even if a child lingers", async () => {
  const t = Date.now();
  const res = await run("sh", FORKS_AND_LINGERS, { detachOutput: true, stdin: "x" });
  assertEquals(res, { code: 0, stdout: "", stderr: "" });
  assert(Date.now() - t < 5_000, `took ${Date.now() - t}ms`);
});

Deno.test({
  name: "piped output with a lingering child hits the timeout instead of hanging",
  // The orphaned `sleep` keeps the pipes (and Deno's read ops) open for a moment.
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const t = Date.now();
    await assertRejects(
      () => run("sh", FORKS_AND_LINGERS, { timeoutMs: 300 }),
      CommandTimeoutError,
    );
    assert(Date.now() - t < 900, `took ${Date.now() - t}ms`);
  },
});

Deno.test("timeout kills a slow command", async () => {
  await assertRejects(() => run("sleep", ["30"], { timeoutMs: 200 }), CommandTimeoutError);
});

Deno.test("timeoutMs 0 disables the limit", async () => {
  const res = await run("sh", ["-c", "sleep 0.2; echo ok"], { timeoutMs: 0 });
  assertEquals(res.stdout, "ok\n");
});

Deno.test("missing binary maps to CommandMissingError", async () => {
  await assertRejects(() => run("definitely-not-a-command-xyz"), CommandMissingError);
});
