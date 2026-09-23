/** Backend selection from `config.asrBackend`. */
import type { Config } from "../config.ts";
import { DashScopeBackend } from "./dashscope.ts";
import { ElevenLabsBackend } from "./elevenlabs.ts";
import type { AsrBackend } from "./types.ts";
import { VllmBackend } from "./vllm.ts";

export type { AsrBackend } from "./types.ts";
export { AsrError } from "./types.ts";

export function createBackend(config: Config): AsrBackend {
  switch (config.asrBackend) {
    case "vllm":
      return new VllmBackend(config.vllm);
    case "elevenlabs":
      return new ElevenLabsBackend(config.elevenlabs);
    case "dashscope":
    default:
      return new DashScopeBackend(config.dashscope);
  }
}
