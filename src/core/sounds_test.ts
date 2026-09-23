import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import { ensureSounds, SOUND_KINDS, synthWav, TONES } from "./sounds.ts";

const RATE = 44_100;

function samples(wav: Uint8Array): Int16Array {
  return new Int16Array(wav.slice(44).buffer);
}

function ascii(wav: Uint8Array, at: number, len: number): string {
  return String.fromCharCode(...wav.slice(at, at + len));
}

Deno.test("synthWav writes a valid PCM16 mono header", () => {
  const wav = synthWav(TONES.start, RATE);
  const view = new DataView(wav.buffer);
  assertEquals(ascii(wav, 0, 4), "RIFF");
  assertEquals(ascii(wav, 8, 4), "WAVE");
  assertEquals(ascii(wav, 12, 4), "fmt ");
  assertEquals(ascii(wav, 36, 4), "data");
  assertEquals(view.getUint32(4, true), wav.length - 8);
  assertEquals(view.getUint16(20, true), 1); // PCM
  assertEquals(view.getUint16(22, true), 1); // mono
  assertEquals(view.getUint32(24, true), RATE);
  assertEquals(view.getUint16(34, true), 16);
  assertEquals(view.getUint32(40, true), wav.length - 44);
});

Deno.test("synthWav duration is the sum of the tones", () => {
  const tones = [{ freq: 440, ms: 100 }, { freq: 0, ms: 50 }, { freq: 880, ms: 150 }];
  assertEquals(samples(synthWav(tones, RATE)).length, Math.round(0.3 * RATE));
});

Deno.test("silence, peak and fades", () => {
  const amp = 0.5;
  const s = samples(synthWav(TONES.start, RATE, amp));
  const n1 = Math.round(0.09 * RATE);
  const gap = s.slice(n1, n1 + Math.round(0.04 * RATE));
  assert(gap.every((v) => v === 0), "gap is silent");

  const peak = s.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert(peak <= Math.round(amp * 32767), `peak ${peak}`);
  assert(peak > amp * 32767 * 0.9, `peak ${peak} too low`);

  assertEquals(s[0], 0);
  assert(Math.abs(s[n1 - 1]) < 50, `end of first tone ${s[n1 - 1]}`);
  assert(Math.abs(s[s.length - 1]) < 50, `last sample ${s[s.length - 1]}`);
});

Deno.test("start and stop are different, error is longer", () => {
  const start = synthWav(TONES.start);
  const stop = synthWav(TONES.stop);
  assertEquals(start.length, stop.length);
  assertNotEquals(start, stop);
  assert(synthWav(TONES.error).length > start.length);
});

Deno.test("ensureSounds writes all tones once and repairs changed files", async () => {
  const dir = join(await Deno.makeTempDir(), "sounds");
  try {
    const paths = await ensureSounds(dir);
    assertEquals(Object.keys(paths).sort(), [...SOUND_KINDS].sort());
    for (const kind of SOUND_KINDS) {
      assertEquals(await Deno.readFile(paths[kind]), synthWav(TONES[kind]));
    }

    const mtime = (await Deno.stat(paths.start)).mtime?.getTime();
    await new Promise((r) => setTimeout(r, 20));
    await ensureSounds(dir);
    assertEquals((await Deno.stat(paths.start)).mtime?.getTime(), mtime, "not rewritten");

    await Deno.writeFile(paths.stop, new Uint8Array([1, 2, 3]));
    await ensureSounds(dir);
    assertEquals(await Deno.readFile(paths.stop), synthWav(TONES.stop));
  } finally {
    await Deno.remove(join(dir, ".."), { recursive: true });
  }
});
