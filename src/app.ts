/**
 * Wires config, helper process, controller, control socket and hotkey mode together.
 * Shared by the desktop and headless entrypoints.
 */
import { ConfigStore } from "./core/config.ts";
import { AlreadyRunningError, startControlServer } from "./core/control.ts";
import { Controller, type ControllerDeps, errMsg } from "./core/controller.ts";
import { Helper, type ReadyEvent, resolveHelperPath } from "./core/helper.ts";
import { currentPlatform, isGnome, type Platform } from "./core/platform/mod.ts";
import { type SettingsInput, settingsPatch } from "./core/settings.ts";
import { ensureWritableDir } from "./core/storage.ts";
import { displayCombo, normalizeCombo } from "./hotkey/combo.ts";
import { gnomeAvailable, registerGnomeShortcut } from "./hotkey/gnome.ts";

/**
 * - `native`: asr-helper grabs the hotkey (macOS, X11).
 * - `gnome`: a GNOME custom shortcut pings the control socket (Wayland).
 * - `none`: no global hotkey; use the tray or `deno task toggle`.
 */
export type HotkeyMode = "native" | "gnome" | "none";

export interface App {
  config: ConfigStore;
  helper: Helper;
  controller: Controller;
  platform: Platform;
  socket: string;
  hotkeyMode(): HotkeyMode;
  /** Validates and applies a new hotkey; on failure the previous one stays active. */
  applyHotkey(combo: string): Promise<void>;
  /** Validates everything first; the hotkey is applied before the config is written. */
  saveSettings(settings: SettingsInput): Promise<void>;
  shutdown(): Promise<void>;
}

export interface AppOptions {
  notify?: ControllerDeps["notify"];
}

export { AlreadyRunningError };

export async function createApp(opts: AppOptions = {}): Promise<App> {
  const platform = currentPlatform();
  const config = new ConfigStore();
  await config.load();

  const helper = new Helper({ command: resolveHelperPath() });
  const controller = new Controller({ helper, config, platform, notify: opts.notify });

  const control = await startControlServer({
    toggle: () => controller.toggle(),
    cancel: () => controller.cancel(),
    status: () => controller.state,
  });

  let mode: HotkeyMode = "none";
  let active: string | null = null;

  async function resolveMode(info: ReadyEvent): Promise<HotkeyMode> {
    if (info.hotkey_supported) return "native";
    if (platform.name === "linux" && isGnome() && await gnomeAvailable()) return "gnome";
    return "none";
  }

  async function bind(combo: string) {
    switch (mode) {
      case "native":
        await helper.request({ cmd: "set_hotkey", combo });
        break;
      case "gnome":
        await registerGnomeShortcut(combo, control.path);
        break;
      case "none":
        throw new Error(
          "No hay atajo global disponible en esta sesión; usa la bandeja o `deno task toggle`",
        );
    }
    active = combo;
  }

  async function applyHotkey(input: string) {
    const combo = normalizeCombo(input);
    try {
      await bind(combo);
    } catch (err) {
      // Native mode already keeps the previous hotkey on failure; GNOME may be half-written.
      if (mode === "gnome" && active && active !== combo) {
        await registerGnomeShortcut(active, control.path).catch(() => {});
      }
      throw err;
    }
  }

  helper.addEventListener("hotkey", () => controller.toggle());
  helper.addEventListener("message", (e) => {
    const detail = (e as CustomEvent).detail;
    if (detail?.event === "error") console.error(`[asr-helper] ${detail.msg}`);
  });
  helper.addEventListener("exit", (e) => {
    const { code } = (e as CustomEvent<{ code: number }>).detail;
    console.error(`[asr-helper] exited with code ${code}; restarting`);
  });
  async function onReady(info: ReadyEvent) {
    mode = await resolveMode(info);
    const combo = config.get().hotkey;
    try {
      await bind(normalizeCombo(combo));
      console.log(`[deno-asr] atajo ${displayCombo(combo)} (${mode})`);
    } catch (err) {
      console.error(`[deno-asr] no se pudo registrar el atajo '${combo}': ${errMsg(err)}`);
    }
  }

  // Re-apply the hotkey whenever the helper restarts.
  let started = false;
  helper.addEventListener("ready", (e) => {
    if (started) onReady((e as CustomEvent<ReadyEvent>).detail);
  });

  try {
    await onReady(await helper.start());
    started = true;
  } catch (err) {
    control.close();
    await helper.close();
    throw err;
  }

  return {
    config,
    helper,
    controller,
    platform,
    socket: control.path,
    hotkeyMode: () => mode,
    applyHotkey,

    async saveSettings({ hotkey, datasetDir, ...asr }) {
      const patch = settingsPatch(asr);
      const combo = normalizeCombo(hotkey);
      const dir = datasetDir.trim();
      if (!dir) throw new Error("El directorio no puede estar vacío");
      await ensureWritableDir(dir);

      if (combo !== active) await applyHotkey(combo);
      await config.update({ ...patch, hotkey: combo, datasetDir: dir });
    },

    async shutdown() {
      if (controller.state === "recording") await controller.cancel().catch(() => {});
      control.close();
      await helper.close();
    },
  };
}
