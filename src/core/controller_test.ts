import { assert, assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import { type ConfigPatch, ConfigStore } from "./config.ts";
import { Controller } from "./controller.ts";
import type { Helper, HelperCommand, HelperEvent } from "./helper.ts";
import { CommandTimeoutError } from "./platform/exec.ts";
import type { Platform } from "./platform/types.ts";
import type { SampleMeta } from "./storage.ts";

interface Level {
  peak: number;
  rms: number;
  gain: number;
}

function fakeHelper(level: Level): { helper: Helper; commands: HelperCommand[] } {
  const commands: HelperCommand[] = [];
  const helper = {
    request(cmd: HelperCommand): Promise<HelperEvent> {
      commands.push(cmd);
      switch (cmd.cmd) {
        case "start":
          return Promise.resolve({ event: "recording", sample_rate: 48000, device: "Fake Mic" });
        case "stop":
          Deno.mkdirSync(dirname(cmd.path), { recursive: true });
          Deno.writeFileSync(cmd.path, new Uint8Array(44));
          return Promise.resolve({ event: "saved", path: cmd.path, duration_sec: 2, ...level });
        default:
          return Promise.resolve({ event: "ok" });
      }
    },
  } as unknown as Helper;
  return { helper, commands };
}

function fakePlatform(overrides: Partial<Platform> = {}): { platform: Platform; calls: string[] } {
  const calls: string[] = [];
  const platform: Platform = {
    name: "linux",
    copy: (text) => {
      calls.push(`copy:${text}`);
      return Promise.resolve();
    },
    readClipboard: () => Promise.resolve(null),
    paste: (keys) => {
      calls.push(`paste:${keys}`);
      return Promise.resolve();
    },
    typeText: () => Promise.resolve(),
    playSound: () => {},
    notify: () => Promise.resolve(),
    pickFolder: () => Promise.resolve(null),
    openPath: () => Promise.resolve(),
    ...overrides,
  };
  return { platform, calls };
}

async function setup(opts: {
  text: string;
  level?: Level;
  platform?: Partial<Platform>;
  config?: ConfigPatch;
}) {
  const dir = await Deno.makeTempDir();
  const config = new ConfigStore(join(dir, "config.json"), {
    datasetDir: join(dir, "dataset"),
    sounds: false,
    restoreClipboard: false,
    ...opts.config,
  });
  const { helper, commands } = fakeHelper(opts.level ?? { peak: 0.9, rms: 0.1, gain: 1 });
  const { platform, calls } = fakePlatform(opts.platform);
  const notes: string[] = [];
  const failures: string[] = [];
  const controller = new Controller({
    helper,
    config,
    platform,
    backendFactory: () => ({
      name: "fake",
      model: "fake-1",
      transcribe: () => Promise.resolve(opts.text),
    }),
    notify: (title) => {
      notes.push(title);
    },
    delay: () => Promise.resolve(),
  });
  controller.addEventListener("failure", (e) => failures.push((e as CustomEvent<string>).detail));

  const readMeta = async (): Promise<SampleMeta> => {
    const stop = commands.find((c) => c.cmd === "stop") as { path: string };
    return JSON.parse(await Deno.readTextFile(stop.path.replace(/\.wav$/, ".json")));
  };
  const cleanup = () => Deno.remove(dir, { recursive: true });
  return { controller, commands, calls, notes, failures, readMeta, cleanup };
}

async function record(controller: Controller) {
  await controller.toggle();
  assertEquals(controller.state, "recording");
  await controller.toggle();
}

// Silence the controller's own console.error lines during tests.
function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const orig = console.error;
  console.error = () => {};
  return fn().finally(() => {
    console.error = orig;
  });
}

Deno.test("happy path: copies, pastes, stores level and asks the helper to normalize", () =>
  quiet(async () => {
    const t = await setup({ text: "hola", level: { peak: 0.9, rms: 0.12, gain: 3 } });
    try {
      await record(t.controller);
      assertEquals(t.controller.state, "idle");
      assertEquals(t.calls, ["copy:hola", "paste:ctrl+v"]);
      assertEquals(t.commands.find((c) => c.cmd === "stop")?.cmd, "stop");
      assert((t.commands.find((c) => c.cmd === "stop") as { normalize?: boolean }).normalize);
      const meta = await t.readMeta();
      assertEquals([meta.text, meta.peak, meta.rms, meta.gain], ["hola", 0.9, 0.12, 3]);
    } finally {
      await t.cleanup();
    }
  }));

Deno.test("copy timing out returns to idle and reports instead of throwing", () =>
  quiet(async () => {
    const t = await setup({
      text: "hola",
      platform: { copy: () => Promise.reject(new CommandTimeoutError("xclip", 3000)) },
    });
    try {
      await record(t.controller);
      assertEquals(t.controller.state, "idle");
      assertEquals(t.failures.length, 1);
      assert(t.failures[0].includes("xclip"), t.failures[0]);
      // Next press starts a new recording: the hotkey is not stuck.
      await t.controller.toggle();
      assertEquals(t.controller.state, "recording");
      await t.controller.cancel();
    } finally {
      await t.cleanup();
    }
  }));

Deno.test("empty text from a near-silent recording warns about the mic level", () =>
  quiet(async () => {
    // 1.4 % raw peak boosted 20x: the warning must look at the pre-gain level.
    const t = await setup({ text: "", level: { peak: 0.28, rms: 0.03, gain: 20 } });
    try {
      await record(t.controller);
      assertEquals(t.notes, ["Audio casi en silencio"]);
      assertEquals(t.calls, []);
    } finally {
      await t.cleanup();
    }
  }));

Deno.test("empty text with normal level keeps the generic notice", () =>
  quiet(async () => {
    const t = await setup({ text: "" });
    try {
      await record(t.controller);
      assertEquals(t.notes, ["Sin texto"]);
    } finally {
      await t.cleanup();
    }
  }));

Deno.test("presses during transcribing are ignored", () =>
  quiet(async () => {
    const t = await setup({ text: "hola" });
    try {
      await t.controller.toggle();
      const stopping = t.controller.toggle();
      assertEquals(t.controller.state, "transcribing");
      await t.controller.toggle();
      await stopping;
      assertEquals(t.controller.state, "idle");
      assertEquals(t.commands.filter((c) => c.cmd === "start").length, 1);
    } finally {
      await t.cleanup();
    }
  }));
