/**
 * Feedback tones generated at runtime (no dependency on the desktop's sound theme):
 * rising pair = mic open, speak now; falling pair = stopped listening; low tone = error.
 */
import { join } from "@std/path";
import type { SoundKind } from "./platform/types.ts";

/** `freq: 0` is silence. */
export type Tone = { freq: number; ms: number };

export const TONES: Record<SoundKind, Tone[]> = {
  start: [{ freq: 660, ms: 90 }, { freq: 0, ms: 40 }, { freq: 990, ms: 90 }],
  stop: [{ freq: 990, ms: 90 }, { freq: 0, ms: 40 }, { freq: 660, ms: 90 }],
  error: [{ freq: 220, ms: 300 }],
};

export const SOUND_KINDS: readonly SoundKind[] = ["start", "stop", "error"];

const FADE_MS = 8;
const HEADER_BYTES = 44;

/** PCM16 mono WAV. Each tone fades in/out over 8 ms to avoid clicks. */
export function synthWav(tones: Tone[], rate = 44_100, amp = 0.5): Uint8Array {
  const counts = tones.map((t) => Math.round((t.ms / 1000) * rate));
  const total = counts.reduce((a, b) => a + b, 0);
  const buf = new Uint8Array(HEADER_BYTES + total * 2);
  const view = new DataView(buf.buffer);
  writeHeader(view, rate, total);

  const fade = Math.round((FADE_MS / 1000) * rate);
  let offset = HEADER_BYTES;
  tones.forEach((tone, i) => {
    const n = counts[i];
    for (let s = 0; s < n; s++) {
      let v = 0;
      if (tone.freq > 0) {
        const env = Math.min(1, s / fade, (n - 1 - s) / fade);
        v = Math.sin((2 * Math.PI * tone.freq * s) / rate) * amp * Math.max(0, env);
      }
      view.setInt16(offset, Math.round(v * 32767), true);
      offset += 2;
    }
  });
  return buf;
}

function writeHeader(view: DataView, rate: number, samples: number) {
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  const dataBytes = samples * 2;
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
}

export function soundCacheDir(): string {
  const home = Deno.env.get("HOME") ?? "/tmp";
  const base = Deno.build.os === "darwin"
    ? join(home, "Library", "Caches")
    : Deno.env.get("XDG_CACHE_HOME") || join(home, ".cache");
  return join(base, "deno-asr", "sounds");
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Writes the WAVs to `dir` (skipping files that already match) and returns their paths. */
export async function ensureSounds(dir = soundCacheDir()): Promise<Record<SoundKind, string>> {
  await Deno.mkdir(dir, { recursive: true });
  const paths = {} as Record<SoundKind, string>;
  for (const kind of SOUND_KINDS) {
    const path = join(dir, `${kind}.wav`);
    const wav = synthWav(TONES[kind]);
    const current = await Deno.readFile(path).catch(() => null);
    if (!current || !sameBytes(current, wav)) {
      const tmp = `${path}.tmp`;
      await Deno.writeFile(tmp, wav);
      await Deno.rename(tmp, path);
    }
    paths[kind] = path;
  }
  return paths;
}
