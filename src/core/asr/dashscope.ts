import { encodeBase64 } from "@std/encoding/base64";
import { type AsrBackend, AsrError, errorFromResponse } from "./types.ts";

/** qwen3-asr-flash accepts audio up to 10 MB. */
export const DASHSCOPE_MAX_BYTES = 10 * 1024 * 1024;

export interface DashScopeOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  fetch?: typeof fetch;
}

type ContentPart = { text?: string };

/** OpenAI-compatible `chat/completions` with an `input_audio` part. */
export class DashScopeBackend implements AsrBackend {
  readonly name = "dashscope";
  readonly model: string;
  #opts: DashScopeOptions;

  constructor(opts: DashScopeOptions) {
    this.#opts = opts;
    this.model = opts.model;
  }

  buildBody(wav: Uint8Array, language: string) {
    return {
      model: this.model,
      messages: [{
        role: "user",
        content: [{
          type: "input_audio",
          input_audio: { data: `data:audio/wav;base64,${encodeBase64(wav)}` },
        }],
      }],
      stream: false,
      asr_options: { language, enable_itn: false },
    };
  }

  async transcribe(wav: Uint8Array, language: string, signal?: AbortSignal): Promise<string> {
    if (!this.#opts.apiKey) {
      throw new AsrError(
        "DashScope API key missing (config dashscope.apiKey or DASHSCOPE_API_KEY)",
      );
    }
    if (wav.byteLength > DASHSCOPE_MAX_BYTES) {
      throw new AsrError(
        `audio is ${(wav.byteLength / 1048576).toFixed(1)} MB; qwen3-asr-flash accepts up to 10 MB`,
      );
    }

    const doFetch = this.#opts.fetch ?? fetch;
    const res = await doFetch(`${this.#opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${this.#opts.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(this.buildBody(wav, language)),
      signal,
    });
    if (!res.ok) throw await errorFromResponse(res, "DashScope");

    const json = await res.json();
    const content: string | ContentPart[] | undefined = json?.choices?.[0]?.message?.content;
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) return content.map((p) => p.text ?? "").join("").trim();
    throw new AsrError("DashScope: unexpected response shape");
  }
}
