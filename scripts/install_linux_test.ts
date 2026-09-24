import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { appIcon } from "../src/desktop/icons.ts";
import {
  APP_ID,
  desktopEntry,
  desktopExecArg,
  installPaths,
  launcherScript,
  missingPackages,
  parseInstallFlags,
  REQUIRED_PACKAGES,
  shq,
  TRAY_EXTENSION,
} from "./install_linux.ts";

const env = (vars: Record<string, string>) => ({ get: (k: string) => vars[k] });

Deno.test("installPaths under ~/.local by default", () => {
  const p = installPaths("/home/u");
  assertEquals(p.appDir, "/home/u/.local/share/deno-asr/app");
  assertEquals(p.exe, "/home/u/.local/share/deno-asr/app/deno-asr");
  assertEquals(p.launcher, "/home/u/.local/share/deno-asr/deno-asr-launch");
  assertEquals(p.bin, "/home/u/.local/bin/deno-asr");
  assertEquals(p.desktop, `/home/u/.local/share/applications/${APP_ID}.desktop`);
  assertEquals(p.autostart, `/home/u/.config/autostart/${APP_ID}.desktop`);
  assertEquals(p.icon, `/home/u/.local/share/icons/hicolor/256x256/apps/${APP_ID}.png`);
  assertEquals(p.log, "/home/u/.local/state/deno-asr/app.log");
});

Deno.test("installPaths honours XDG dirs", () => {
  const p = installPaths(
    "/home/u",
    env({ XDG_DATA_HOME: "/d", XDG_CONFIG_HOME: "/c", XDG_STATE_HOME: "/s" }),
  );
  assertEquals(p.appDir, "/d/deno-asr/app");
  assertEquals(p.autostart, `/c/autostart/${APP_ID}.desktop`);
  assertEquals(p.log, "/s/deno-asr/app.log");
  assertEquals(p.bin, "/home/u/.local/bin/deno-asr");
});

Deno.test("launcher redirects output to the log and execs the app", () => {
  const p = installPaths("/home/u");
  const s = launcherScript(p, false);
  assert(s.startsWith("#!/bin/sh\n"));
  assertStringIncludes(s, `exec '${p.exe}' "$@" >>'${p.log}' 2>&1`);
  assertStringIncludes(s, `mkdir -p '${p.stateDir}'`);
  assert(!s.includes("ASR_DEBUG"));
  assertStringIncludes(launcherScript(p, true), "export ASR_DEBUG='*'");
});

Deno.test("shq quotes spaces and single quotes", () => {
  assertEquals(shq("/a b/c"), "'/a b/c'");
  assertEquals(shq("it's"), `'it'\\''s'`);
});

Deno.test("desktop entry: absolute Exec, autostart keys only in autostart", () => {
  const menu = desktopEntry({
    launcher: "/home/u/.local/share/deno-asr/deno-asr-launch",
    autostart: false,
  });
  assertStringIncludes(menu, "Exec=/home/u/.local/share/deno-asr/deno-asr-launch\n");
  assertStringIncludes(menu, `Icon=${APP_ID}\n`);
  assertStringIncludes(menu, `StartupWMClass=${APP_ID}\n`);
  assert(!menu.includes("X-GNOME-Autostart"));

  const auto = desktopEntry({ launcher: "/x/launch", autostart: true });
  assertStringIncludes(auto, "X-GNOME-Autostart-enabled=true\n");
  assertStringIncludes(auto, "X-GNOME-Autostart-Delay=5\n");
});

Deno.test("desktop Exec quoting handles spaces and specials", () => {
  assertEquals(desktopExecArg("/plain/path"), "/plain/path");
  assertEquals(desktopExecArg("/home/my user/launch"), `"/home/my user/launch"`);
  assertEquals(desktopExecArg("/a$b/100%"), `"/a\\\\$b/100%%"`);
  const entry = desktopEntry({ launcher: "/home/my user/launch", autostart: false });
  assertStringIncludes(entry, `Exec="/home/my user/launch"\n`);
});

Deno.test("missingPackages: reports missing, ydotool only on Wayland, tray extension", async () => {
  const installed = new Set([...REQUIRED_PACKAGES.filter((p) => p !== "xclip")]);
  const statusOf = (pkg: string) =>
    Promise.resolve(installed.has(pkg) ? "install ok installed" : null);

  const x11 = await missingPackages(statusOf, false);
  assertEquals(x11.missing, ["xclip"]);
  assertEquals(x11.trayExtension, false);

  installed.add(TRAY_EXTENSION);
  const wayland = await missingPackages(statusOf, true);
  assertEquals(wayland.missing, ["xclip", "ydotool"]);
  assertEquals(wayland.trayExtension, true);

  // "deinstall ok config-files" means removed.
  const removed = await missingPackages(
    (pkg) =>
      Promise.resolve(pkg === "zenity" ? "deinstall ok config-files" : "install ok installed"),
    false,
  );
  assertEquals(removed.missing, ["zenity"]);
});

Deno.test("parseInstallFlags", () => {
  assertEquals(parseInstallFlags([]), { build: true, autostart: true, launch: true, debug: false });
  assertEquals(
    parseInstallFlags(["--no-build", "--no-autostart", "--no-launch", "--debug"]),
    { build: false, autostart: false, launch: false, debug: true },
  );
  assertThrows(() => parseInstallFlags(["--nope"]), Error, "flag desconocido");
});

Deno.test("appIcon is a 256x256 RGBA PNG", async () => {
  const png = await appIcon(256);
  assertEquals([...png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(png.buffer);
  assertEquals(String.fromCharCode(...png.slice(12, 16)), "IHDR");
  assertEquals(view.getUint32(16), 256);
  assertEquals(view.getUint32(20), 256);
  assertEquals(png[24], 8); // bit depth
  assertEquals(png[25], 6); // RGBA
});
