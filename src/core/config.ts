import { dirname, join } from "@std/path";

export type AsrBackendName = "dashscope" | "vllm" | "elevenlabs";
export const ASR_BACKENDS: readonly AsrBackendName[] = ["dashscope", "vllm", "elevenlabs"];
export type OutputMode = "paste" | "type" | "clipboard";
export const OUTPUT_MODES: readonly OutputMode[] = ["paste", "type", "clipboard"];

export interface Config {
  /** `global-hotkey` accelerator, e.g. `CmdOrCtrl+Shift+Space`. */
  hotkey: string;
  datasetDir: string;
  language: string;
  asrBackend: AsrBackendName;
  dashscope: { apiKey: string; baseUrl: string; model: string };
  vllm: { baseUrl: string; model: string; apiKey: string };
  elevenlabs: { apiKey: string; baseUrl: string; model: string; tagAudioEvents: boolean };
  /** Input device name as reported by the helper; `null` = system default. */
  mic: string | null;
  outputMode: OutputMode;
  restoreClipboard: boolean;
  /** Linux only: `ctrl+v` or `ctrl+shift+v` (terminals). */
  pasteKeys: "ctrl+v" | "ctrl+shift+v";
  sounds: boolean;
  notifications: boolean;
  /** Auto-stop after this many seconds (DashScope accepts up to 10 MB ≈ 5 min). */
  maxSeconds: number;
  /** Recordings shorter than this are discarded. */
  minSeconds: number;
  /** Boost quiet recordings (peak < 50 %) up to 90 % peak, max 20x gain. */
  normalize: boolean;
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
export type ConfigPatch = DeepPartial<Config>;

function home(): string {
  return Deno.env.get("HOME") ?? Deno.cwd();
}

export function configDir(): string {
  if (Deno.build.os === "darwin") return join(home(), "Library", "Application Support", "deno-asr");
  return join(Deno.env.get("XDG_CONFIG_HOME") ?? join(home(), ".config"), "deno-asr");
}

export function defaults(): Config {
  return {
    hotkey: "CmdOrCtrl+Shift+Space",
    datasetDir: join(home(), "deno-asr-dataset"),
    language: "es",
    asrBackend: "dashscope",
    dashscope: {
      apiKey: "",
      baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      model: "qwen3-asr-flash",
    },
    vllm: { baseUrl: "http://localhost:8000/v1", model: "Qwen/Qwen3-ASR-1.7B", apiKey: "" },
    elevenlabs: {
      apiKey: "",
      baseUrl: "https://api.elevenlabs.io",
      model: "scribe_v2",
      tagAudioEvents: false,
    },
    mic: null,
    outputMode: "paste",
    restoreClipboard: true,
    pasteKeys: "ctrl+v",
    sounds: true,
    notifications: true,
    maxSeconds: 300,
    minSeconds: 0.3,
    normalize: true,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function merge<T>(base: T, patch: unknown): T {
  if (!isObject(base) || !isObject(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = k in out && isObject(out[k]) && isObject(v) ? merge(out[k], v) : v;
  }
  return out as T;
}

/** Environment overrides; never persisted. */
export function envPatch(env: Pick<typeof Deno.env, "get"> = Deno.env): ConfigPatch {
  const patch: ConfigPatch = {};
  const get = (k: string) => env.get(k) || undefined;

  const backend = get("ASR_BACKEND");
  if (ASR_BACKENDS.includes(backend as AsrBackendName)) {
    patch.asrBackend = backend as AsrBackendName;
  }
  if (get("ASR_LANGUAGE")) patch.language = get("ASR_LANGUAGE");
  if (get("HOTKEY")) patch.hotkey = get("HOTKEY");
  if (get("DATASET_DIR")) patch.datasetDir = get("DATASET_DIR");
  if (get("MIC")) patch.mic = get("MIC");

  const output = get("OUTPUT_MODE");
  if (OUTPUT_MODES.includes(output as OutputMode)) patch.outputMode = output as OutputMode;

  const dashscope = {
    apiKey: get("DASHSCOPE_API_KEY"),
    baseUrl: get("DASHSCOPE_BASE_URL"),
    model: get("DASHSCOPE_MODEL"),
  };
  if (Object.values(dashscope).some(Boolean)) patch.dashscope = dashscope;

  const vllm = {
    baseUrl: get("VLLM_BASE_URL"),
    model: get("VLLM_MODEL"),
    apiKey: get("VLLM_API_KEY"),
  };
  if (Object.values(vllm).some(Boolean)) patch.vllm = vllm;

  const elevenlabs = { apiKey: get("ELEVENLABS_API_KEY"), model: get("ELEVENLABS_MODEL") };
  if (Object.values(elevenlabs).some(Boolean)) patch.elevenlabs = elevenlabs;

  return patch;
}

export interface ConfigChange {
  prev: Config;
  next: Config;
}

/**
 * Effective config = defaults ← config.json ← environment.
 * `update()` persists only the file layer, so env secrets never hit disk.
 * Dispatches `change` (CustomEvent<ConfigChange>).
 */
export class ConfigStore extends EventTarget {
  #path: string;
  #file: ConfigPatch = {};
  #env: ConfigPatch;
  #effective: Config;

  constructor(path = join(configDir(), "config.json"), env: ConfigPatch = envPatch()) {
    super();
    this.#path = path;
    this.#env = env;
    this.#effective = this.#compute();
  }

  get path(): string {
    return this.#path;
  }

  /** Values coming from environment variables; they win over anything saved. */
  get env(): ConfigPatch {
    return this.#env;
  }

  get(): Config {
    return this.#effective;
  }

  #compute(): Config {
    return merge(merge(defaults(), this.#file), this.#env);
  }

  async load(): Promise<Config> {
    try {
      const parsed = JSON.parse(await Deno.readTextFile(this.#path));
      this.#file = isObject(parsed) ? parsed as ConfigPatch : {};
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
      // First run: write the full defaults so the file is self-documenting.
      this.#file = defaults();
      await this.#persist();
    }
    this.#effective = this.#compute();
    return this.#effective;
  }

  async update(patch: ConfigPatch): Promise<Config> {
    const prev = this.#effective;
    this.#file = merge(this.#file, patch);
    await this.#persist();
    this.#effective = this.#compute();
    this.dispatchEvent(
      new CustomEvent<ConfigChange>("change", { detail: { prev, next: this.#effective } }),
    );
    return this.#effective;
  }

  async #persist() {
    await Deno.mkdir(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify(this.#file, null, 2) + "\n", { mode: 0o600 });
    await Deno.rename(tmp, this.#path);
  }
}
