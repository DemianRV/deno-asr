import { type AsrBackend, AsrError, errorFromResponse } from "./types.ts";

export interface VllmOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetch?: typeof fetch;
}

/** OpenAI-compatible `audio/transcriptions` as served by `vllm serve Qwen/Qwen3-ASR-*`. */
export class VllmBackend implements AsrBackend {
  readonly name = "vllm";
  readonly model: string;
  #opts: VllmOptions;

  constructor(opts: VllmOptions) {
    this.#opts = opts;
    this.model = opts.model;
  }

  buildForm(wav: Uint8Array, language: string): FormData {
    const form = new FormData();
    form.append(
      "file",
      new Blob([wav as Uint8Array<ArrayBuffer>], { type: "audio/wav" }),
      "audio.wav",
    );
    form.append("model", this.model);
    form.append("language", language);
    form.append("response_format", "json");
    return form;
  }

  async transcribe(wav: Uint8Array, language: string, signal?: AbortSignal): Promise<string> {
    const headers: Record<string, string> = {};
    if (this.#opts.apiKey) headers.authorization = `Bearer ${this.#opts.apiKey}`;

    const doFetch = this.#opts.fetch ?? fetch;
    const res = await doFetch(`${this.#opts.baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers,
      body: this.buildForm(wav, language),
      signal,
    });
    if (!res.ok) throw await errorFromResponse(res, "vLLM");

    const json = await res.json();
    if (typeof json?.text !== "string") throw new AsrError("vLLM: unexpected response shape");
    return json.text.trim();
  }
}
