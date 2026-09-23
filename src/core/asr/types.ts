/** A speech-to-text service. `name` and `model` are recorded in each sample's `.json`. */
export interface AsrBackend {
  readonly name: string;
  readonly model: string;
  /** `wav` is a complete 16 kHz mono PCM16 file; returns the trimmed transcript. */
  transcribe(wav: Uint8Array, language: string, signal?: AbortSignal): Promise<string>;
}

export class AsrError extends Error {
  override name = "AsrError";
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export async function errorFromResponse(res: Response, backend: string): Promise<AsrError> {
  let detail = "";
  try {
    const body = await res.text();
    try {
      const json = JSON.parse(body);
      detail = json?.error?.message ?? json?.message ?? json?.detail ?? body;
    } catch {
      detail = body;
    }
  } catch {
    // ignore
  }
  const msg = `${backend} HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 300)}` : ""}`;
  return new AsrError(msg, res.status);
}
