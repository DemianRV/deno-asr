import { assertEquals, assertRejects } from "@std/assert";
import { decodeBase64 } from "@std/encoding/base64";
import { DASHSCOPE_MAX_BYTES, DashScopeBackend } from "./dashscope.ts";
import { ElevenLabsBackend, type ElevenLabsOptions } from "./elevenlabs.ts";
import { VllmBackend } from "./vllm.ts";
import { AsrError } from "./types.ts";

const wav = new Uint8Array([82, 73, 70, 70, 1, 2, 3]);

function mockFetch(respond: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init! });
    return Promise.resolve(respond(url, init!));
  };
  return { fetch: fn as typeof fetch, calls };
}

Deno.test("DashScope sends input_audio and parses string content", async () => {
  const m = mockFetch(() => Response.json({ choices: [{ message: { content: " hola mundo " } }] }));
  const b = new DashScopeBackend({
    apiKey: "sk",
    baseUrl: "https://example.test/v1/",
    model: "qwen3-asr-flash",
    fetch: m.fetch,
  });
  assertEquals(await b.transcribe(wav, "es"), "hola mundo");

  const { url, init } = m.calls[0];
  assertEquals(url, "https://example.test/v1/chat/completions");
  assertEquals((init.headers as Record<string, string>).authorization, "Bearer sk");
  const body = JSON.parse(init.body as string);
  assertEquals(body.model, "qwen3-asr-flash");
  assertEquals(body.asr_options, { language: "es", enable_itn: false });
  const data: string = body.messages[0].content[0].input_audio.data;
  assertEquals(decodeBase64(data.replace("data:audio/wav;base64,", "")), wav);
});

Deno.test("DashScope parses array content and surfaces HTTP errors", async () => {
  let res = Response.json({ choices: [{ message: { content: [{ text: "a" }, { text: "b" }] } }] });
  const b = new DashScopeBackend({
    apiKey: "sk",
    baseUrl: "https://example.test",
    model: "m",
    fetch: mockFetch(() => res).fetch,
  });
  assertEquals(await b.transcribe(wav, "es"), "ab");

  res = new Response('{"error":{"message":"bad key"}}', { status: 401 });
  await assertRejects(() => b.transcribe(wav, "es"), AsrError);
});

Deno.test("DashScope validates key and size before calling", async () => {
  const m = mockFetch(() => new Response());
  const noKey = new DashScopeBackend({ apiKey: "", baseUrl: "x", model: "m", fetch: m.fetch });
  await assertRejects(() => noKey.transcribe(wav, "es"), AsrError, "API key");
  const b = new DashScopeBackend({ apiKey: "sk", baseUrl: "x", model: "m", fetch: m.fetch });
  await assertRejects(
    () => b.transcribe(new Uint8Array(DASHSCOPE_MAX_BYTES + 1), "es"),
    AsrError,
    "10 MB",
  );
  assertEquals(m.calls.length, 0);
});

Deno.test("vLLM posts multipart to audio/transcriptions", async () => {
  const m = mockFetch(() => Response.json({ text: " hola " }));
  const b = new VllmBackend({
    baseUrl: "http://localhost:8000/v1",
    model: "Qwen/Qwen3-ASR-1.7B",
    fetch: m.fetch,
  });
  assertEquals(await b.transcribe(wav, "es"), "hola");

  const { url, init } = m.calls[0];
  assertEquals(url, "http://localhost:8000/v1/audio/transcriptions");
  assertEquals((init.headers as Record<string, string>).authorization, undefined);
  const form = init.body as FormData;
  assertEquals(form.get("model"), "Qwen/Qwen3-ASR-1.7B");
  assertEquals(form.get("language"), "es");
  const file = form.get("file") as File;
  assertEquals(file.name, "audio.wav");
  assertEquals(new Uint8Array(await file.arrayBuffer()), wav);
});

function elevenlabs(fetchFn: typeof fetch, opts: Partial<ElevenLabsOptions> = {}) {
  return new ElevenLabsBackend({
    apiKey: "xi",
    baseUrl: "https://api.elevenlabs.io/",
    model: "scribe_v2",
    tagAudioEvents: false,
    fetch: fetchFn,
    ...opts,
  });
}

Deno.test("ElevenLabs posts multipart with xi-api-key", async () => {
  const m = mockFetch(() => Response.json({ text: " hola ", language_code: "spa" }));
  assertEquals(await elevenlabs(m.fetch).transcribe(wav, "es"), "hola");

  const { url, init } = m.calls[0];
  assertEquals(url, "https://api.elevenlabs.io/v1/speech-to-text");
  assertEquals((init.headers as Record<string, string>)["xi-api-key"], "xi");
  const form = init.body as FormData;
  assertEquals(form.get("model_id"), "scribe_v2");
  assertEquals(form.get("language_code"), "es");
  assertEquals(form.get("tag_audio_events"), "false");
  assertEquals(form.get("timestamps_granularity"), "none");
  const file = form.get("file") as File;
  assertEquals(file.name, "audio.wav");
  assertEquals(new Uint8Array(await file.arrayBuffer()), wav);
});

Deno.test("ElevenLabs validates key and surfaces HTTP errors", async () => {
  const m = mockFetch(() => new Response('{"detail":{"message":"invalid key"}}', { status: 401 }));
  await assertRejects(
    () => elevenlabs(m.fetch, { apiKey: "" }).transcribe(wav, "es"),
    AsrError,
    "API key",
  );
  assertEquals(m.calls.length, 0);

  const err = await assertRejects(() => elevenlabs(m.fetch).transcribe(wav, "es"), AsrError);
  assertEquals(err.status, 401);
});
