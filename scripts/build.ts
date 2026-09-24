/**
 * deno run -A scripts/build.ts <mac|linux>
 *
 * 1. cargo build --release (asr-helper)
 * 2. deno desktop
 * 3. place asr-helper next to the app executable (the app looks for it in
 *    dirname(Deno.execPath()))
 * 4. macOS: localize the mic usage string and re-sign the bundle
 */
import { dirname, join } from "@std/path";

const ROOT = new URL("..", import.meta.url).pathname;
const HELPER = join(ROOT, "helper/target/release/asr-helper");
const MIC_USAGE = "Deno ASR graba tu voz para transcribirla y guardar el audio en tu dataset.";

async function sh(cmd: string, args: string[], opts: { cwd?: string } = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const { code } = await new Deno.Command(cmd, {
    args,
    cwd: opts.cwd ?? ROOT,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (code !== 0) throw new Error(`${cmd} failed with exit code ${code}`);
}

async function copyExecutable(from: string, to: string) {
  await Deno.mkdir(dirname(to), { recursive: true });
  await Deno.copyFile(from, to);
  await Deno.chmod(to, 0o755);
  console.log(`+ ${to}`);
}

async function buildHelper() {
  await sh("cargo", ["build", "--release", "--manifest-path", "helper/Cargo.toml"]);
}

function desktopArgs(output: string): string[] {
  return ["desktop", "-A", "--include", "ui/", "-o", output, "src/desktop.ts"];
}

async function buildMac() {
  const app = join(ROOT, "dist/DenoASR.app");
  await Deno.remove(app, { recursive: true }).catch(() => {});
  await buildHelper();
  // deno desktop appends `.app` itself.
  await sh("deno", desktopArgs("dist/DenoASR"));

  const macos = join(app, "Contents/MacOS");
  await copyExecutable(HELPER, join(macos, "asr-helper"));

  const plist = join(app, "Contents/Info.plist");
  const buddy = "/usr/libexec/PlistBuddy";
  await sh(buddy, ["-c", `Set :NSMicrophoneUsageDescription ${MIC_USAGE}`, plist]).catch(() =>
    sh(buddy, ["-c", `Add :NSMicrophoneUsageDescription string ${MIC_USAGE}`, plist])
  );
  await sh(buddy, ["-c", "Set :CFBundleName Deno ASR", plist]);
  await sh(buddy, ["-c", "Add :LSUIElement bool true", plist]).catch(() =>
    sh(buddy, ["-c", "Set :LSUIElement true", plist])
  );

  await sh("codesign", ["--force", "--deep", "--sign", "-", app]);
  await sh("codesign", ["--verify", "--deep", "--strict", app]);
  console.log(`\n✓ ${app}`);
}

async function findDirContaining(root: string, names: string[]): Promise<string | null> {
  for await (const entry of Deno.readDir(root)) {
    const path = join(root, entry.name);
    if (entry.isFile && names.includes(entry.name)) return root;
    if (entry.isDirectory) {
      const found = await findDirContaining(path, names);
      if (found) return found;
    }
  }
  return null;
}

export async function buildLinux() {
  const out = join(ROOT, "dist/deno-asr");
  await Deno.remove(out, { recursive: true }).catch(() => {});
  await buildHelper();
  await sh("deno", desktopArgs("dist/deno-asr"));

  // Directory output: put the helper beside the runtime so dirname(execPath) finds it.
  const runtimeDir = await findDirContaining(out, ["libruntime.so", "laufey_webview"]) ?? out;
  await copyExecutable(HELPER, join(runtimeDir, "asr-helper"));
  if (runtimeDir !== out) await copyExecutable(HELPER, join(out, "asr-helper"));
  console.log(`\n✓ ${out}`);
}

if (import.meta.main) {
  switch (Deno.args[0]) {
    case "mac":
      if (Deno.build.os !== "darwin") throw new Error("build:mac must run on macOS");
      await buildMac();
      break;
    case "linux":
      if (Deno.build.os !== "linux") throw new Error("build:linux must run on Linux");
      await buildLinux();
      break;
    default:
      console.error("usage: deno run -A scripts/build.ts <mac|linux>");
      Deno.exit(64);
  }
}
