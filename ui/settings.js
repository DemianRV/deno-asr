// Runs inside the deno desktop webview; `bindings` is provided by the runtime.
/* global bindings */

const $ = (id) => document.getElementById(id);
const hotkeyBtn = $("hotkey-btn");
const hotkeyReset = $("hotkey-reset");
const hotkeyHint = $("hotkey-hint");
const dirInput = $("dir");
const status = $("status");
const saveBtn = $("save");
const backendSel = $("backend");
const outputSel = $("output");
const languageInput = $("language");
const vllmUrl = $("vllm-url");
const vllmModel = $("vllm-model");

const SECRETS = ["dashscope", "elevenlabs", "vllm"];
const ENV_KEY = {
  dashscope: "DASHSCOPE_API_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
  vllm: "VLLM_API_KEY",
};
// Remember the static help text so env / stored-key notes can be appended to it.
const defaultHints = new Map(
  [...document.querySelectorAll(".hint[id]")].map((el) => [el.id, el.textContent.trim()]),
);

const MODIFIER_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "OSLeft",
  "OSRight",
  "Fn",
]);

const state = {
  settings: null,
  hotkey: "",
  recording: false,
  /** Keys the user asked to remove; sent as `null` on save. */
  clear: new Set(),
};

function setStatus(text, kind = "") {
  status.textContent = text;
  status.className = kind;
}

function hotkeyHintFor(mode) {
  switch (mode) {
    case "gnome":
      return ["Se registra como atajo personalizado de GNOME (Ajustes › Teclado).", ""];
    case "none":
      return [
        "Esta sesión no admite atajos globales. Usa la bandeja o `deno task toggle`.",
        "warn",
      ];
    default:
      return ["Pulsa el botón y después la combinación de teclas.", ""];
  }
}

function setHint(id, extra = "", kind = "") {
  const el = $(id);
  el.textContent = [defaultHints.get(id), extra].filter(Boolean).join(" ");
  el.className = `hint ${kind}`;
}

function fillSelect(select, options, value) {
  select.replaceChildren(
    ...options.map(({ id, label }) => new Option(label, id, id === value, id === value)),
  );
}

/** Disables a field overridden by an environment variable and says which one. */
function lockField(el, hintId, envName) {
  el.disabled = !!envName;
  setHint(
    hintId,
    envName ? `Definido por ${envName}, que tiene prioridad.` : "",
    envName ? "warn" : "",
  );
}

function showPanel(backend) {
  for (const panel of document.querySelectorAll(".panel")) {
    panel.hidden = panel.dataset.backend !== backend;
  }
}

function renderSecret(name) {
  const view = state.settings.secrets[name];
  const input = $(`${name}-key`);
  const clearBtn = $(`${name}-clear`);
  input.value = "";
  input.disabled = view.fromEnv;
  clearBtn.hidden = !view.set || view.fromEnv;
  clearBtn.textContent = state.clear.has(name) ? "Deshacer" : "Quitar";

  if (view.fromEnv) {
    input.placeholder = `Desde ${ENV_KEY[name]} (${view.hint})`;
    setHint(`${name}-hint`, `Definida por ${ENV_KEY[name]}, que tiene prioridad.`, "warn");
  } else if (state.clear.has(name)) {
    input.placeholder = "Se borrará al guardar";
    setHint(`${name}-hint`);
  } else {
    input.placeholder = view.set
      ? `Guardada (${view.hint}) · escribe para reemplazarla`
      : "Pega tu API key";
    setHint(`${name}-hint`);
  }
}

async function load() {
  const s = await bindings.getSettings();
  state.settings = s;
  state.hotkey = s.hotkey;
  state.clear.clear();

  hotkeyBtn.textContent = s.hotkeyLabel;
  dirInput.value = s.datasetDir;
  $("config-path").textContent = s.configPath;
  const [hint, kind] = hotkeyHintFor(s.hotkeyMode);
  hotkeyHint.textContent = hint;
  hotkeyHint.className = `hint ${kind}`;

  fillSelect(backendSel, s.backends, s.asrBackend);
  fillSelect(outputSel, s.outputModes, s.outputMode);
  languageInput.value = s.language;
  vllmUrl.value = s.vllm.baseUrl;
  vllmModel.value = s.vllm.model;

  lockField(backendSel, "backend-hint", s.envLocked.asrBackend);
  lockField(languageInput, "language-hint", s.envLocked.language);
  lockField(outputSel, "output-hint", s.envLocked.outputMode);
  lockField(vllmUrl, "vllm-url-hint", s.envLocked.vllmBaseUrl);
  lockField(vllmModel, "vllm-model-hint", s.envLocked.vllmModel);
  for (const name of SECRETS) renderSecret(name);

  showPanel(s.asrBackend);
  setStatus("");
}

function collect() {
  const s = state.settings;
  const payload = { hotkey: state.hotkey, datasetDir: dirInput.value };
  if (!s.envLocked.asrBackend) payload.asrBackend = backendSel.value;
  if (!s.envLocked.language) payload.language = languageInput.value;
  if (!s.envLocked.outputMode) payload.outputMode = outputSel.value;

  for (const name of SECRETS) {
    if (s.secrets[name].fromEnv) continue;
    const typed = $(`${name}-key`).value.trim();
    // undefined keeps the stored key; null removes it.
    const apiKey = typed || (state.clear.has(name) ? null : undefined);
    payload[name] = { apiKey };
  }
  payload.vllm ??= {};
  if (!s.envLocked.vllmBaseUrl) payload.vllm.baseUrl = vllmUrl.value;
  if (!s.envLocked.vllmModel) payload.vllm.model = vllmModel.value;
  return payload;
}

function comboFromEvent(e) {
  const mods = [];
  if (e.metaKey) mods.push("Super");
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  return { mods, code: e.code };
}

async function startRecording() {
  if (state.recording) return;
  state.recording = true;
  hotkeyBtn.classList.add("recording");
  hotkeyBtn.textContent = "Pulsa la combinación…";
  hotkeyReset.hidden = false;
  setStatus("Esc para cancelar.");
  await bindings.pauseHotkey();
}

async function stopRecording(restoreLabel = true) {
  if (!state.recording) return;
  state.recording = false;
  hotkeyBtn.classList.remove("recording");
  hotkeyReset.hidden = true;
  if (restoreLabel) {
    const d = await bindings.describeHotkey(state.hotkey);
    hotkeyBtn.textContent = d.ok ? d.label : state.hotkey;
  }
  await bindings.resumeHotkey();
}

async function onKeyDown(e) {
  if (!state.recording) return;
  e.preventDefault();
  e.stopPropagation();

  if (e.code === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    await stopRecording();
    setStatus("");
    return;
  }
  if (MODIFIER_CODES.has(e.code)) return; // wait for the main key

  const { mods, code } = comboFromEvent(e);
  if (!mods.some((m) => m !== "Shift")) {
    setStatus("Usa al menos Ctrl, Alt o ⌘/Super además de la tecla.", "error");
    return;
  }

  const d = await bindings.describeHotkey([...mods, code].join("+"));
  if (!d.ok) {
    setStatus(d.error, "error");
    return;
  }
  state.hotkey = d.hotkey;
  hotkeyBtn.textContent = d.label;
  await stopRecording(false);
  setStatus("Pulsa Guardar para aplicar.");
}

async function pick() {
  const res = await bindings.pickFolder();
  if (res && typeof res === "object" && res.error) {
    setStatus(res.error, "error");
  } else if (typeof res === "string" && res) {
    dirInput.value = res;
    setStatus("Pulsa Guardar para aplicar.");
  }
}

async function save() {
  if (state.recording) await stopRecording();
  saveBtn.disabled = true;
  setStatus("Guardando…");
  try {
    const res = await bindings.saveSettings(collect());
    if (res.ok) {
      setStatus("Guardado ✓", "ok");
      await load();
      setStatus("Guardado ✓", "ok");
    } else {
      setStatus(res.error, "error");
    }
  } catch (err) {
    setStatus(err?.message ?? String(err), "error");
  } finally {
    saveBtn.disabled = false;
  }
}

async function close() {
  if (state.recording) await stopRecording();
  await bindings.closeSettings();
}

hotkeyBtn.addEventListener("click", startRecording);
hotkeyReset.addEventListener("click", () => stopRecording().then(() => setStatus("")));
$("pick").addEventListener("click", pick);
saveBtn.addEventListener("click", save);
$("cancel").addEventListener("click", close);
globalThis.addEventListener("keydown", onKeyDown, true);
globalThis.addEventListener("blur", () => stopRecording());
for (const input of document.querySelectorAll("input")) {
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") save();
  });
}
backendSel.addEventListener("change", () => showPanel(backendSel.value));
for (const name of SECRETS) {
  $(`${name}-clear`).addEventListener("click", () => {
    if (state.clear.has(name)) state.clear.delete(name);
    else state.clear.add(name);
    renderSecret(name);
  });
}

load().catch((err) => setStatus(err?.message ?? String(err), "error"));
