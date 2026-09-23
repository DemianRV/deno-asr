import { assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import {
  ensureWritableDir,
  isoLocal,
  newSample,
  sampleId,
  type SampleMeta,
  writeMeta,
} from "./storage.ts";

const at = new Date(2026, 8, 23, 1, 2, 3);

Deno.test("sampleId and newSample layout", () => {
  assertEquals(sampleId(at, "abcd"), "20260923-010203-abcd");
  const s = newSample("/data", at);
  assertEquals(s.dir, join("/data", "2026-09-23"));
  assertMatch(s.wavPath, /\/data\/2026-09-23\/20260923-010203-[0-9a-f]{4}\.wav$/);
  assertEquals(s.jsonPath, s.wavPath.replace(/\.wav$/, ".json"));
});

Deno.test("isoLocal includes the UTC offset", () => {
  assertMatch(isoLocal(at), /^2026-09-23T01:02:03[+-]\d{2}:\d{2}$/);
});

Deno.test("writeMeta writes JSON atomically", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await ensureWritableDir(join(dir, "nested"));
    const path = join(dir, "nested", "x.json");
    const meta: SampleMeta = {
      id: "x",
      audio: "x.wav",
      text: "hola",
      text_corrected: null,
      reviewed: false,
      language: "es",
      backend: "dashscope",
      model: "qwen3-asr-flash",
      duration_sec: 1.5,
      sample_rate: 16000,
      created_at: isoLocal(at),
      platform: "darwin",
      status: "ok",
    };
    await writeMeta(path, meta);
    assertEquals(JSON.parse(await Deno.readTextFile(path)), meta);
    assertEquals([...Deno.readDirSync(join(dir, "nested"))].map((e) => e.name), ["x.json"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
