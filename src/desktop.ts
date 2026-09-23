/**
 * `deno desktop` entrypoint: tray icon + menu, hidden settings window served from `ui/`,
 * and the bindings the window calls. Closing the window hides it; "Salir" quits.
 */
import { AlreadyRunningError, type App, createApp } from "./app.ts";
import { ASR_BACKENDS, type AsrBackendName } from "./core/config.ts";
import { errMsg, type State } from "./core/controller.ts";
import { currentPlatform } from "./core/platform/mod.ts";
import { BACKEND_LABEL, type SettingsInput, settingsView } from "./core/settings.ts";
import { type BrowserWindow, desktopApi, type MenuItem, webNotify } from "./desktop/api.ts";
import { trayIcons } from "./desktop/icons.ts";
import { displayCombo, normalizeCombo } from "./hotkey/combo.ts";

const UI_DIR = new URL("../ui/", import.meta.url);
const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
};

function serveUi() {
  Deno.serve(async (req) => {
    const { pathname } = new URL(req.url);
    const file = pathname === "/" ? "settings.html" : pathname.slice(1);
    if (!/^[\w-]+\.(html|js|css)$/.test(file)) return new Response("not found", { status: 404 });
    try {
      const body = await Deno.readFile(new URL(file, UI_DIR));
      const ext = file.split(".").pop()!;
      return new Response(body, {
        headers: { "content-type": CONTENT_TYPES[ext], "cache-control": "no-store" },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}

const STATE_LABEL: Record<State, string> = {
  idle: "Listo",
  starting: "Abriendo micrófono…",
  recording: "Grabando…",
  transcribing: "Transcribiendo…",
};

const BACKEND_ID_PREFIX = "backend:";

// MenuItem has no checked state: mark the active backend in the label.
function backendMenu(app: App): MenuItem {
  const current = app.config.get().asrBackend;
  return {
    submenu: {
      label: `Motor: ${BACKEND_LABEL[current]}`,
      items: ASR_BACKENDS.map((b) => ({
        item: {
          label: `${b === current ? "✓ " : "    "}${BACKEND_LABEL[b]}`,
          id: `${BACKEND_ID_PREFIX}${b}`,
          enabled: true,
        },
      })),
    },
  };
}

function trayMenu(app: App, state: State): MenuItem[] {
  const hotkey = displayCombo(app.config.get().hotkey);
  return [
    {
      item: {
        label: state === "recording" ? "Parar y transcribir" : "Grabar",
        id: "toggle",
        enabled: state === "idle" || state === "recording",
      },
    },
    { item: { label: "Cancelar grabación", id: "cancel", enabled: state === "recording" } },
    "separator",
    { item: { label: `${STATE_LABEL[state]} · Atajo: ${hotkey}`, id: "info", enabled: false } },
    backendMenu(app),
    { item: { label: "Ajustes…", id: "settings", enabled: true } },
    { item: { label: "Abrir carpeta del dataset", id: "open", enabled: true } },
    "separator",
    { item: { label: "Salir", id: "quit", enabled: true } },
  ];
}

function bindSettings(win: BrowserWindow, app: App, onSaved: () => void, hide: () => void) {
  const nativeHotkey = () => app.hotkeyMode() === "native";

  win.bind("getSettings", () => {
    const cfg = app.config.get();
    return {
      hotkey: cfg.hotkey,
      hotkeyLabel: displayCombo(cfg.hotkey),
      hotkeyMode: app.hotkeyMode(),
      datasetDir: cfg.datasetDir,
      os: Deno.build.os,
      configPath: app.config.path,
      ...settingsView(cfg, app.config.env),
    };
  });

  win.bind("describeHotkey", (combo: string) => {
    try {
      const normalized = normalizeCombo(combo);
      return { ok: true, hotkey: normalized, label: displayCombo(normalized) };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  win.bind("saveSettings", async (settings: SettingsInput) => {
    try {
      await app.saveSettings(settings);
      onSaved();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  win.bind("pickFolder", async () => {
    try {
      return await app.platform.pickFolder(
        "Elige el directorio donde guardar audios y transcripciones",
      );
    } catch (err) {
      return { error: errMsg(err) };
    }
  });

  // Keeps the current global hotkey from firing while the user records a new one.
  win.bind("pauseHotkey", async () => {
    if (nativeHotkey()) await app.helper.request({ cmd: "pause_hotkey" }).catch(() => {});
  });
  win.bind("resumeHotkey", async () => {
    if (nativeHotkey()) await app.helper.request({ cmd: "resume_hotkey" }).catch(() => {});
  });

  win.bind("closeSettings", () => hide());
}

async function main() {
  const api = desktopApi();
  const platform = currentPlatform();

  let app: App;
  try {
    app = await createApp({
      notify: async (title, body) => {
        if (!webNotify(title, body)) await platform.notify(title, body);
      },
    });
  } catch (err) {
    const msg = err instanceof AlreadyRunningError
      ? "Deno ASR ya está en marcha (mira la barra de menús / bandeja)."
      : `No se pudo iniciar Deno ASR: ${errMsg(err)}`;
    console.error(msg);
    alert(msg);
    Deno.exit(1);
  }

  serveUi();

  // First construction adopts the implicit startup window.
  const win = new api.BrowserWindow({
    title: "Deno ASR · Ajustes",
    width: 560,
    height: 680,
    resizable: true,
  });
  win.hide();
  if (Deno.build.os === "darwin") api.dock.setVisible(false);

  const hideSettings = () => {
    win.hide();
    if (app.hotkeyMode() === "native") app.helper.request({ cmd: "resume_hotkey" }).catch(() => {});
  };
  const showSettings = () => {
    win.reload();
    win.show();
    win.focus();
  };

  win.addEventListener("close", (e) => {
    e.preventDefault();
    hideSettings();
  });

  const icons = await trayIcons();
  const tray = new api.Tray();
  if (tray.trayId === 0) console.error("[deno-asr] la bandeja del sistema no está disponible");

  const render = (state: State) => {
    const idle = state === "idle";
    const onLinux = Deno.build.os === "linux";
    // Ubuntu's top bar is dark regardless of theme: use the light glyph there.
    tray.setIcon(
      idle
        ? (onLinux ? icons.idleDark : icons.idle)
        : state === "recording"
        ? icons.recording
        : icons.busy,
    );
    tray.setIconDark(idle ? icons.idleDark : null);
    tray.setTooltip(`Deno ASR · ${STATE_LABEL[state]}`);
    tray.setMenu(trayMenu(app, state));
  };
  render(app.controller.state);

  app.controller.addEventListener("state", (e) => render((e as CustomEvent<State>).detail));
  app.config.addEventListener("change", () => render(app.controller.state));

  const quit = async () => {
    await app.shutdown();
    tray.destroy();
    Deno.exit(0);
  };

  tray.addEventListener("menuclick", async (e) => {
    const id = (e as CustomEvent<{ id: string }>).detail.id;
    if (id.startsWith(BACKEND_ID_PREFIX)) {
      const backend = id.slice(BACKEND_ID_PREFIX.length) as AsrBackendName;
      if (ASR_BACKENDS.includes(backend)) {
        await app.config.update({ asrBackend: backend }).catch((err) =>
          console.error(`[deno-asr] no se pudo guardar el motor: ${errMsg(err)}`)
        );
      }
      return;
    }
    switch (id) {
      case "toggle":
        await app.controller.toggle();
        break;
      case "cancel":
        await app.controller.cancel();
        break;
      case "settings":
        showSettings();
        break;
      case "open": {
        const dir = app.config.get().datasetDir;
        await Deno.mkdir(dir, { recursive: true }).catch(() => {});
        await app.platform.openPath(dir).catch((err) => console.error(errMsg(err)));
        break;
      }
      case "quit":
        await quit();
        break;
    }
  });

  bindSettings(win, app, () => render(app.controller.state), hideSettings);

  Deno.addSignalListener("SIGINT", quit);
  Deno.addSignalListener("SIGTERM", quit);
}

if (import.meta.main) {
  await main();
}
