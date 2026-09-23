/**
 * Dataset layout: `{datasetDir}/YYYY-MM-DD/{id}.wav` (written by asr-helper) plus
 * `{id}.json` metadata (written here). `text_corrected`/`reviewed` are for manual review.
 */
import { join } from "@std/path";

export interface SamplePaths {
  id: string;
  dir: string;
  wavPath: string;
  jsonPath: string;
  createdAt: Date;
}

export interface SampleMeta {
  id: string;
  audio: string;
  text: string | null;
  text_corrected: string | null;
  reviewed: boolean;
  language: string;
  backend: string;
  model: string;
  duration_sec: number;
  sample_rate: number;
  /** Level of the WAV as written, 0–1 of full scale. */
  peak?: number;
  rms?: number;
  /** Normalization gain applied by the helper (1 = untouched). */
  gain?: number;
  created_at: string;
  platform: string;
  status: "ok" | "error";
  error?: string;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

function datePart(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local-time ISO 8601 with offset, e.g. `2026-09-23T01:36:00+02:00`. */
export function isoLocal(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `${datePart(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function sampleId(d: Date, rand = crypto.randomUUID().slice(0, 4)): string {
  const date = datePart(d).replaceAll("-", "");
  return `${date}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${rand}`;
}

/** `{datasetDir}/YYYY-MM-DD/{id}.wav|json`. Directories are created by the writers. */
export function newSample(datasetDir: string, now = new Date()): SamplePaths {
  const id = sampleId(now);
  const dir = join(datasetDir, datePart(now));
  return {
    id,
    dir,
    wavPath: join(dir, `${id}.wav`),
    jsonPath: join(dir, `${id}.json`),
    createdAt: now,
  };
}

export async function writeMeta(path: string, meta: SampleMeta): Promise<void> {
  const tmp = `${path}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(meta, null, 2) + "\n");
  await Deno.rename(tmp, path);
}

/** Ensures the directory exists and is writable. */
export async function ensureWritableDir(dir: string): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  const probe = join(dir, `.write-test-${crypto.randomUUID()}`);
  await Deno.writeTextFile(probe, "");
  await Deno.remove(probe);
}
