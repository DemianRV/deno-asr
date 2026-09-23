/**
 * Headless entrypoint: same core as the desktop app, no tray or window.
 * Control it with the global hotkey or `deno task toggle|status|cancel`.
 */
import { AlreadyRunningError, createApp } from "./app.ts";
import { errMsg } from "./core/controller.ts";
import { displayCombo } from "./hotkey/combo.ts";

if (import.meta.main) {
  let app;
  try {
    app = await createApp();
  } catch (err) {
    console.error(`deno-asr: ${errMsg(err)}`);
    Deno.exit(err instanceof AlreadyRunningError ? 2 : 1);
  }

  const cfg = app.config.get();
  console.log(`deno-asr (headless) · config: ${app.config.path}`);
  console.log(`  dataset: ${cfg.datasetDir}`);
  console.log(`  backend: ${cfg.asrBackend} · idioma: ${cfg.language}`);
  console.log(`  atajo:   ${displayCombo(cfg.hotkey)} (${app.hotkeyMode()})`);
  console.log(`  toggle manual: deno task toggle`);

  app.controller.addEventListener("state", (e) => {
    console.log(`[estado] ${(e as CustomEvent).detail}`);
  });
  app.controller.addEventListener("result", (e) => {
    const { text, sample } = (e as CustomEvent).detail;
    console.log(`[texto] ${text}\n        ${sample.wavPath}`);
  });

  const shutdown = async () => {
    await app.shutdown();
    Deno.exit(0);
  };
  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);
}
