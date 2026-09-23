import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { AlreadyRunningError, sendControl, startControlServer } from "./control.ts";

Deno.test("control socket: commands, single instance, cleanup", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "t.sock");
  let toggles = 0;
  const server = await startControlServer({
    toggle: () => void toggles++,
    cancel: () => {},
    status: () => (toggles ? "recording" : "idle"),
  }, path);
  try {
    assertEquals(await sendControl("status", path), "idle");
    assertEquals(await sendControl("toggle", path), "ok");
    assertEquals(toggles, 1);
    assertEquals(await sendControl("status", path), "recording");
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);

    await assertRejects(
      () => startControlServer({ toggle() {}, cancel() {}, status: () => "" }, path),
      AlreadyRunningError,
    );
  } finally {
    server.close();
    await Deno.remove(dir, { recursive: true });
  }
});
