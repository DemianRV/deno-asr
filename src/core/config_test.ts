import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ConfigStore, defaults, envPatch, merge } from "./config.ts";

const env = (vars: Record<string, string>) => ({ get: (k: string) => vars[k] });

Deno.test("merge is deep and skips undefined", () => {
  const out = merge({ a: 1, n: { x: 1, y: 2 } }, { n: { y: 3, z: undefined }, b: 2 });
  assertEquals(out, { a: 1, n: { x: 1, y: 3 }, b: 2 } as unknown);
});

Deno.test("envPatch reads known vars only", () => {
  assertEquals(envPatch(env({})), {});
  assertEquals(
    envPatch(env({ ASR_BACKEND: "vllm", OUTPUT_MODE: "nope", DASHSCOPE_API_KEY: "sk" })),
    { asrBackend: "vllm", dashscope: { apiKey: "sk", baseUrl: undefined, model: undefined } },
  );
});

Deno.test("envPatch: elevenlabs backend and key; unknown backend ignored", () => {
  assertEquals(
    envPatch(env({ ASR_BACKEND: "elevenlabs", ELEVENLABS_API_KEY: "xi" })),
    { asrBackend: "elevenlabs", elevenlabs: { apiKey: "xi", model: undefined } },
  );
  assertEquals(envPatch(env({ ASR_BACKEND: "whisper" })), {});
  const cfg = merge(defaults(), envPatch(env({ ELEVENLABS_MODEL: "scribe_v1" })));
  assertEquals(cfg.elevenlabs, {
    apiKey: "",
    baseUrl: "https://api.elevenlabs.io",
    model: "scribe_v1",
    tagAudioEvents: false,
  });
});

Deno.test("ConfigStore: defaults on first run, env not persisted", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "sub", "config.json");
    const store = new ConfigStore(path, envPatch(env({ DASHSCOPE_API_KEY: "secret" })));
    const cfg = await store.load();
    assertEquals(cfg.dashscope.apiKey, "secret");
    assertEquals(cfg.language, "es");
    assertEquals(JSON.parse(await Deno.readTextFile(path)), defaults());
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);

    let changed = "";
    store.addEventListener("change", (e) => {
      changed = (e as CustomEvent).detail.next.hotkey;
    });
    await store.update({ hotkey: "Ctrl+Alt+KeyR" });
    assertEquals(changed, "Ctrl+Alt+KeyR");

    const onDisk = JSON.parse(await Deno.readTextFile(path));
    assertEquals(onDisk.hotkey, "Ctrl+Alt+KeyR");
    assertEquals(onDisk.dashscope.apiKey, "");

    const reloaded = await new ConfigStore(path, {}).load();
    assertEquals(reloaded.hotkey, "Ctrl+Alt+KeyR");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
