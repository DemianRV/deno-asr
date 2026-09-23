/** Sends one command to a running instance over the control socket and prints the reply. */
import { type ControlCommand, sendControl, socketPath } from "./core/control.ts";

const COMMANDS: ControlCommand[] = ["toggle", "status", "cancel"];

if (import.meta.main) {
  const cmd = Deno.args[0] as ControlCommand;
  if (!COMMANDS.includes(cmd)) {
    console.error(`uso: deno run -A src/cli.ts <${COMMANDS.join("|")}>`);
    Deno.exit(64);
  }
  try {
    console.log(await sendControl(cmd));
  } catch {
    console.error(`deno-asr no está en marcha (${socketPath()})`);
    Deno.exit(1);
  }
}
