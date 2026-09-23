import { assertEquals, assertRejects } from "@std/assert";
import { Helper, HelperError, type RecordingEvent, type SavedEvent } from "./helper.ts";

const FAKE = new URL("./testdata/fake_helper.ts", import.meta.url).pathname;

function fakeHelper(restart = false) {
  return new Helper({
    command: Deno.execPath(),
    args: ["run", "-A", FAKE],
    timeoutMs: 5_000,
    restart,
  });
}

Deno.test("Helper request/response over JSON lines", async () => {
  const h = fakeHelper();
  try {
    const ready = await h.start(20_000);
    assertEquals(ready.version, "fake");

    const rec = await h.request<RecordingEvent>({ cmd: "start", device: "USB" });
    assertEquals(rec.device, "USB");

    const saved = await h.request<SavedEvent>({ cmd: "stop", path: "/tmp/x.wav", normalize: true });
    assertEquals(saved, {
      event: "saved",
      path: "/tmp/x.wav",
      duration_sec: 1.25,
      peak: 0.9,
      rms: 0.1,
      gain: 2,
    });

    await assertRejects(
      () => h.request({ cmd: "set_hotkey", combo: "bad" }),
      HelperError,
      "invalid hotkey",
    );
  } finally {
    await h.close();
  }
});

Deno.test("Helper dispatches unsolicited hotkey events", async () => {
  const h = fakeHelper();
  try {
    await h.start(20_000);
    const got = new Promise<void>((resolve) => h.addEventListener("hotkey", () => resolve()));
    await h.request({ cmd: "pause_hotkey" });
    await got;
  } finally {
    await h.close();
  }
});

Deno.test("Helper request times out", async () => {
  const h = fakeHelper();
  try {
    await h.start(20_000);
    await assertRejects(() => h.request({ cmd: "list_devices" }, 200), HelperError);
  } finally {
    await h.close();
  }
});

Deno.test("Helper restarts after a crash and re-emits ready", async () => {
  const h = fakeHelper(true);
  try {
    await h.start(20_000);
    const readyAgain = new Promise<void>((resolve) => h.addEventListener("ready", () => resolve()));
    // deno-lint-ignore no-explicit-any
    h.request({ cmd: "crash" } as any).catch(() => {});
    await readyAgain;
    const rec = await h.request<RecordingEvent>({ cmd: "start" });
    assertEquals(rec.device, "Fake Mic");
  } finally {
    await h.close();
  }
});
