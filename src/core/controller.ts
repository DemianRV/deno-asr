import { type AsrBackend, createBackend } from "./asr/mod.ts";
import type { Config, ConfigStore } from "./config.ts";
import type { Helper, SavedEvent } from "./helper.ts";
import type { Platform } from "./platform/mod.ts";
import { isoLocal, newSample, type SampleMeta, type SamplePaths, writeMeta } from "./storage.ts";

export type State = "idle" | "starting" | "recording" | "transcribing";

export interface ResultDetail {
  text: string;
  sample: SamplePaths;
  delivered: "paste" | "type" | "clipboard";
}

export interface ControllerDeps {
  helper: Helper;
  config: ConfigStore;
  platform: Platform;
  backendFactory?: (config: Config) => AsrBackend;
  /** Overrides `platform.notify` (e.g. Web Notification in `deno desktop`). */
  notify?: (title: string, body: string) => Promise<void> | void;
  delay?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function truncate(s: string, n = 120): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * idle → starting → recording → transcribing → idle.
 *
 * Events: `state` CustomEvent<State>, `result` CustomEvent<ResultDetail>,
 * `failure` CustomEvent<string>.
 */
export class Controller extends EventTarget {
  #deps: ControllerDeps;
  #state: State = "idle";
  #autoStop?: ReturnType<typeof setTimeout>;
  #startedAt = 0;

  constructor(deps: ControllerDeps) {
    super();
    this.#deps = deps;
  }

  get state(): State {
    return this.#state;
  }

  get recordingSeconds(): number {
    return this.#state === "recording" ? (Date.now() - this.#startedAt) / 1000 : 0;
  }

  #set(state: State) {
    if (this.#state === state) return;
    this.#state = state;
    this.dispatchEvent(new CustomEvent<State>("state", { detail: state }));
  }

  async toggle(): Promise<void> {
    switch (this.#state) {
      case "idle":
        return await this.start();
      case "recording":
        return await this.stop();
      default:
        // starting / transcribing: ignore extra presses
        return;
    }
  }

  async start(): Promise<void> {
    if (this.#state !== "idle") return;
    const cfg = this.#deps.config.get();
    this.#set("starting");
    try {
      await this.#deps.helper.request({ cmd: "start", device: cfg.mic ?? undefined });
    } catch (err) {
      this.#set("idle");
      await this.#fail(`No se pudo abrir el micrófono: ${errMsg(err)}`);
      return;
    }
    this.#startedAt = Date.now();
    this.#set("recording");
    if (cfg.sounds) this.#deps.platform.playSound("start");
    if (cfg.maxSeconds > 0) {
      this.#autoStop = setTimeout(() => this.stop(), cfg.maxSeconds * 1000);
    }
  }

  /** Discards the current recording. */
  async cancel(): Promise<void> {
    if (this.#state !== "recording") return;
    clearTimeout(this.#autoStop);
    try {
      await this.#deps.helper.request({ cmd: "cancel" });
    } finally {
      this.#set("idle");
    }
  }

  async stop(): Promise<void> {
    if (this.#state !== "recording") return;
    clearTimeout(this.#autoStop);
    const cfg = this.#deps.config.get();
    const sample = newSample(cfg.datasetDir);
    this.#set("transcribing");
    if (cfg.sounds) this.#deps.platform.playSound("stop");

    try {
      await this.#process(cfg, sample);
    } finally {
      this.#set("idle");
    }
  }

  async #process(cfg: Config, sample: SamplePaths) {
    let saved: SavedEvent;
    try {
      // Resampling long recordings takes a moment; allow generous time.
      saved = await this.#deps.helper.request<SavedEvent>(
        { cmd: "stop", path: sample.wavPath },
        120_000,
      );
    } catch (err) {
      await this.#fail(`No se pudo guardar el audio: ${errMsg(err)}`);
      return;
    }

    if (saved.duration_sec < cfg.minSeconds) {
      await Deno.remove(sample.wavPath).catch(() => {});
      await this.#fail("Grabación demasiado corta, descartada", false);
      return;
    }

    const backend = (this.#deps.backendFactory ?? createBackend)(cfg);
    const meta: SampleMeta = {
      id: sample.id,
      audio: `${sample.id}.wav`,
      text: null,
      text_corrected: null,
      reviewed: false,
      language: cfg.language,
      backend: backend.name,
      model: backend.model,
      duration_sec: Math.round(saved.duration_sec * 100) / 100,
      sample_rate: 16000,
      created_at: isoLocal(sample.createdAt),
      platform: this.#deps.platform.name,
      status: "ok",
    };

    let text: string;
    try {
      const wav = await Deno.readFile(sample.wavPath);
      text = await backend.transcribe(wav, cfg.language, AbortSignal.timeout(120_000));
    } catch (err) {
      // Keep the audio so it can be re-transcribed later.
      meta.status = "error";
      meta.error = errMsg(err);
      await writeMeta(sample.jsonPath, meta).catch(() => {});
      await this.#fail(`Error de transcripción: ${meta.error}`);
      return;
    }

    meta.text = text;
    await writeMeta(sample.jsonPath, meta);

    if (!text) {
      await this.#notify("Sin texto", "El modelo no devolvió transcripción.");
      return;
    }

    const delivered = await this.#deliver(cfg, text);
    this.dispatchEvent(
      new CustomEvent<ResultDetail>("result", { detail: { text, sample, delivered } }),
    );
  }

  async #deliver(cfg: Config, text: string): Promise<ResultDetail["delivered"]> {
    const { platform } = this.#deps;
    const delay = this.#deps.delay ?? sleep;

    if (cfg.outputMode === "type") {
      try {
        await platform.typeText(text);
        return "type";
      } catch (err) {
        await platform.copy(text);
        await this.#notify("Texto copiado", `No se pudo escribir: ${errMsg(err)}`);
        return "clipboard";
      }
    }

    const previous = cfg.outputMode === "paste" && cfg.restoreClipboard
      ? await platform.readClipboard().catch(() => null)
      : null;

    await platform.copy(text);
    if (cfg.outputMode === "clipboard") {
      await this.#notify("Texto copiado", truncate(text));
      return "clipboard";
    }

    try {
      await delay(80);
      await platform.paste(cfg.pasteKeys);
    } catch (err) {
      await this.#notify("Texto copiado", `No se pudo pegar: ${errMsg(err)}`);
      return "clipboard";
    }

    if (previous !== null) {
      // Give the target app time to read the clipboard before restoring it.
      delay(400).then(() => platform.copy(previous)).catch(() => {});
    }
    return "paste";
  }

  async #notify(title: string, body: string) {
    if (!this.#deps.config.get().notifications) return;
    try {
      await (this.#deps.notify ?? this.#deps.platform.notify)(title, body);
    } catch {
      // notifications are best effort
    }
  }

  async #fail(message: string, sound = true) {
    console.error(`[deno-asr] ${message}`);
    this.dispatchEvent(new CustomEvent<string>("failure", { detail: message }));
    if (sound && this.#deps.config.get().sounds) this.#deps.platform.playSound("error");
    await this.#notify("Deno ASR", message);
  }
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
