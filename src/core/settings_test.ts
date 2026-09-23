import { assertEquals, assertThrows } from "@std/assert";
import { defaults, merge } from "./config.ts";
import { settingsPatch, settingsView } from "./settings.ts";

Deno.test("settingsPatch: secrets keep, replace or clear", () => {
  const patch = settingsPatch({
    dashscope: { apiKey: " sk-new " },
    elevenlabs: { apiKey: null },
    vllm: { apiKey: "" },
  });
  const stored = merge(defaults(), {
    dashscope: { apiKey: "sk-old" },
    elevenlabs: { apiKey: "xi-old" },
    vllm: { apiKey: "v-old" },
  });
  const next = merge(stored, patch);
  assertEquals(next.dashscope.apiKey, "sk-new");
  assertEquals(next.elevenlabs.apiKey, "");
  assertEquals(next.vllm.apiKey, "v-old");
});

Deno.test("settingsPatch: validates and omits locked fields", () => {
  const patch = settingsPatch({
    asrBackend: "elevenlabs",
    language: " pt-BR ",
    outputMode: "clipboard",
    vllm: { baseUrl: "http://gpu:8000/v1", model: " Qwen/Qwen3-ASR-0.6B " },
  });
  assertEquals(patch.asrBackend, "elevenlabs");
  assertEquals(patch.language, "pt-BR");
  assertEquals(patch.outputMode, "clipboard");
  assertEquals(patch.vllm, {
    apiKey: undefined,
    baseUrl: "http://gpu:8000/v1",
    model: "Qwen/Qwen3-ASR-0.6B",
  });

  const empty = settingsPatch({});
  assertEquals(empty.asrBackend, undefined);
  assertEquals(merge(defaults(), empty), defaults());
});

Deno.test("settingsPatch: rejects bad input", () => {
  // deno-lint-ignore no-explicit-any
  assertThrows(() => settingsPatch({ asrBackend: "whisper" as any }), Error, "Motor");
  // deno-lint-ignore no-explicit-any
  assertThrows(() => settingsPatch({ outputMode: "print" as any }), Error, "salida");
  assertThrows(() => settingsPatch({ language: "español" }), Error, "Idioma");
  assertThrows(() => settingsPatch({ vllm: { baseUrl: "localhost:8000" } }), Error, "vLLM");
  assertThrows(() => settingsPatch({ vllm: { baseUrl: "ftp://x/v1" } }), Error, "http");
  assertThrows(() => settingsPatch({ vllm: { model: "  " } }), Error, "modelo");
});

Deno.test("settingsView: masks keys and reports env overrides", () => {
  const cfg = merge(defaults(), {
    asrBackend: "vllm",
    dashscope: { apiKey: "sk-1234567890abcd" },
    elevenlabs: { apiKey: "xi-from-env-9999" },
  });
  const view = settingsView(cfg, {
    asrBackend: "vllm",
    elevenlabs: { apiKey: "xi-from-env-9999" },
  });

  assertEquals(view.secrets.dashscope, { set: true, fromEnv: false, hint: "…abcd" });
  assertEquals(view.secrets.elevenlabs, { set: true, fromEnv: true, hint: "…9999" });
  assertEquals(view.secrets.vllm, { set: false, fromEnv: false, hint: "" });
  assertEquals(view.envLocked, { asrBackend: "ASR_BACKEND" });
  assertEquals(view.backends.map((b) => b.id), ["dashscope", "vllm", "elevenlabs"]);
  assertEquals(JSON.stringify(view).includes("sk-1234567890abcd"), false);
});
