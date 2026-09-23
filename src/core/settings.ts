/**
 * What the settings window can read and write. API keys never leave Deno in clear:
 * the window only learns whether one is stored and its last 4 characters.
 */
import {
  ASR_BACKENDS,
  type AsrBackendName,
  type Config,
  type ConfigPatch,
  OUTPUT_MODES,
  type OutputMode,
} from "./config.ts";

export const BACKEND_LABEL: Record<AsrBackendName, string> = {
  dashscope: "Qwen3-ASR · DashScope",
  vllm: "Qwen3-ASR · vLLM local",
  elevenlabs: "ElevenLabs Scribe",
};

export const OUTPUT_LABEL: Record<OutputMode, string> = {
  paste: "Pegar en la app activa",
  type: "Teclear carácter a carácter",
  clipboard: "Solo copiar al portapapeles",
};

/** `undefined` or `""` keeps the stored key, `null` clears it, a string replaces it. */
export type SecretInput = string | null | undefined;

/** Fields locked by environment variables are omitted by the window. */
export interface AsrSettingsInput {
  asrBackend?: AsrBackendName;
  language?: string;
  outputMode?: OutputMode;
  dashscope?: { apiKey?: SecretInput };
  elevenlabs?: { apiKey?: SecretInput };
  vllm?: { baseUrl?: string; model?: string; apiKey?: SecretInput };
}

export interface SettingsInput extends AsrSettingsInput {
  hotkey: string;
  datasetDir: string;
}

export interface SecretView {
  set: boolean;
  fromEnv: boolean;
  /** e.g. `…a1b2`; empty when unset. */
  hint: string;
}

export interface AsrSettingsView {
  asrBackend: AsrBackendName;
  language: string;
  outputMode: OutputMode;
  backends: { id: AsrBackendName; label: string }[];
  outputModes: { id: OutputMode; label: string }[];
  vllm: { baseUrl: string; model: string };
  secrets: Record<"dashscope" | "elevenlabs" | "vllm", SecretView>;
  /** Env variable name per field when the environment overrides it. */
  envLocked: Partial<
    Record<"asrBackend" | "language" | "outputMode" | "vllmBaseUrl" | "vllmModel", string>
  >;
}

const LANGUAGE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

function secret(input: SecretInput): string | undefined {
  if (input === null) return "";
  const value = input?.trim();
  return value ? value : undefined;
}

function secretView(value: string, fromEnv: boolean): SecretView {
  return {
    set: value.length > 0,
    fromEnv,
    hint: value.length > 8 ? `…${value.slice(-4)}` : value ? "…" : "",
  };
}

/** Validates window input and turns it into a config patch. Throws user-facing messages. */
export function settingsPatch(input: AsrSettingsInput): ConfigPatch {
  const patch: ConfigPatch = {};

  if (input.asrBackend !== undefined) {
    if (!ASR_BACKENDS.includes(input.asrBackend)) {
      throw new Error(`Motor desconocido: ${input.asrBackend}`);
    }
    patch.asrBackend = input.asrBackend;
  }

  if (input.outputMode !== undefined) {
    if (!OUTPUT_MODES.includes(input.outputMode)) {
      throw new Error(`Modo de salida desconocido: ${input.outputMode}`);
    }
    patch.outputMode = input.outputMode;
  }

  if (input.language !== undefined) {
    const language = input.language.trim();
    if (!LANGUAGE_RE.test(language)) {
      throw new Error("Idioma no válido: usa un código como es, en o pt-BR");
    }
    patch.language = language;
  }

  const vllm: NonNullable<ConfigPatch["vllm"]> = { apiKey: secret(input.vllm?.apiKey) };
  if (input.vllm?.baseUrl !== undefined) {
    const baseUrl = input.vllm.baseUrl.trim();
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new Error("URL de vLLM no válida");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("La URL de vLLM debe empezar por http:// o https://");
    }
    vllm.baseUrl = baseUrl;
  }
  if (input.vllm?.model !== undefined) {
    const model = input.vllm.model.trim();
    if (!model) throw new Error("El modelo de vLLM no puede estar vacío");
    vllm.model = model;
  }

  patch.dashscope = { apiKey: secret(input.dashscope?.apiKey) };
  patch.elevenlabs = { apiKey: secret(input.elevenlabs?.apiKey) };
  patch.vllm = vllm;
  return patch;
}

export function settingsView(cfg: Config, env: ConfigPatch): AsrSettingsView {
  const envLocked: AsrSettingsView["envLocked"] = {};
  if (env.asrBackend !== undefined) envLocked.asrBackend = "ASR_BACKEND";
  if (env.language !== undefined) envLocked.language = "ASR_LANGUAGE";
  if (env.outputMode !== undefined) envLocked.outputMode = "OUTPUT_MODE";
  if (env.vllm?.baseUrl) envLocked.vllmBaseUrl = "VLLM_BASE_URL";
  if (env.vllm?.model) envLocked.vllmModel = "VLLM_MODEL";

  return {
    asrBackend: cfg.asrBackend,
    language: cfg.language,
    outputMode: cfg.outputMode,
    backends: ASR_BACKENDS.map((id) => ({ id, label: BACKEND_LABEL[id] })),
    outputModes: OUTPUT_MODES.map((id) => ({ id, label: OUTPUT_LABEL[id] })),
    vllm: { baseUrl: cfg.vllm.baseUrl, model: cfg.vllm.model },
    secrets: {
      dashscope: secretView(cfg.dashscope.apiKey, !!env.dashscope?.apiKey),
      elevenlabs: secretView(cfg.elevenlabs.apiKey, !!env.elevenlabs?.apiKey),
      vllm: secretView(cfg.vllm.apiKey, !!env.vllm?.apiKey),
    },
    envLocked,
  };
}
