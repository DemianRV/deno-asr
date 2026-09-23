import { type AsrBackend, AsrError, errorFromResponse } from "./types.ts";

export interface ElevenLabsOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Scribe inserts tags like "(risas)" when enabled; noise for a training dataset. */
  tagAudioEvents: boolean;
  fetch?: typeof fetch;
}

/** ElevenLabs Scribe batch speech-to-text: multipart `POST /v1/speech-to-text`. */
export class ElevenLabsBackend implements AsrBackend {
  readonly name = "elevenlabs";
  readonly model: string;
  #opts: ElevenLabsOptions;

  constructor(opts: ElevenLabsOptions) {
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
    form.append("model_id", this.model);
    if (language) form.append("language_code", language);
    form.append("tag_audio_events", String(this.#opts.tagAudioEvents));
    form.append("timestamps_granularity", "none");
    return form;
  }

  async transcribe(wav: Uint8Array, language: string, signal?: AbortSignal): Promise<string> {
    if (!this.#opts.apiKey) {
      throw new AsrError(
        "ElevenLabs API key missing (config elevenlabs.apiKey or ELEVENLABS_API_KEY)",
      );
    }

    const doFetch = this.#opts.fetch ?? fetch;
    const res = await doFetch(`${this.#opts.baseUrl.replace(/\/$/, "")}/v1/speech-to-text`, {
      method: "POST",
      headers: { "xi-api-key": this.#opts.apiKey },
      body: this.buildForm(wav, language),
      signal,
    });
    if (!res.ok) throw await errorFromResponse(res, "ElevenLabs");

    const json = await res.json();
    if (typeof json?.text !== "string") throw new AsrError("ElevenLabs: unexpected response shape");
    return json.text.trim();
  }
}
