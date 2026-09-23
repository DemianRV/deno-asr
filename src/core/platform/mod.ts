import { darwin } from "./darwin.ts";
import { linux } from "./linux.ts";
import type { Platform } from "./types.ts";

export type { Platform, SoundKind } from "./types.ts";
export { isGnome, isWayland } from "./linux.ts";

export function currentPlatform(): Platform {
  switch (Deno.build.os) {
    case "darwin":
      return darwin;
    case "linux":
      return linux;
    default:
      throw new Error(`unsupported OS: ${Deno.build.os}`);
  }
}
