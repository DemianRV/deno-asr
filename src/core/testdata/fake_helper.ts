// Stand-in for asr-helper speaking the same JSON-lines protocol.
import { TextLineStream } from "@std/streams/text-line-stream";

const enc = new TextEncoder();
const emit = (msg: Record<string, unknown>) =>
  Deno.stdout.writeSync(enc.encode(JSON.stringify(msg) + "\n"));

emit({ event: "ready", version: "fake", hotkey_supported: true });

const lines = Deno.stdin.readable
  .pipeThrough(new TextDecoderStream())
  .pipeThrough(new TextLineStream());

for await (const line of lines) {
  const { id, cmd, ...args } = JSON.parse(line);
  switch (cmd) {
    case "start":
      emit({ id, event: "recording", sample_rate: 48000, device: args.device ?? "Fake Mic" });
      break;
    case "stop":
      emit({
        id,
        event: "saved",
        path: args.path,
        duration_sec: 1.25,
        peak: 0.9,
        rms: 0.1,
        gain: args.normalize ? 2 : 1,
      });
      break;
    case "set_hotkey":
      if (args.combo === "bad") emit({ id, event: "error", msg: "invalid hotkey" });
      else emit({ id, event: "ok" });
      break;
    case "pause_hotkey":
      emit({ event: "hotkey" });
      emit({ id, event: "ok" });
      break;
    case "list_devices":
      // never answers: exercises request timeouts
      break;
    case "crash":
      Deno.exit(3);
      break;
    case "quit":
      emit({ id, event: "ok" });
      Deno.exit(0);
      break;
    default:
      emit({ id, event: "error", msg: `unknown command ${cmd}` });
  }
}
