# asr-helper

Binario nativo mínimo (sin UI) que hace las dos cosas que Deno no puede hacer sin FFI:

- **Grabar del micrófono** (`cpal`) y escribir un WAV 16 kHz mono PCM16 (`rubato` + `hound`).
- **Capturar un atajo global** (`global-hotkey`) en macOS y Linux X11.

No sabe nada de ASR, dataset ni ajustes: Deno decide la ruta de cada WAV y qué atajo registrar.

```bash
cargo build --release     # target/release/asr-helper
cargo test
```

## Protocolo

JSON por líneas (un objeto por línea, UTF-8, `\n`).

- **stdin**: comandos de Deno. Todos llevan `id` (u64); la respuesta lo repite.
- **stdout**: eventos. Solo protocolo, nunca logs.
- **stderr**: logs libres (Deno lo hereda).
- **EOF en stdin** → el helper termina (cierra el micro si estaba grabando). Así nunca queda
  huérfano.

Los eventos sin `id` son espontáneos (`ready`, `hotkey`, errores del stream o líneas mal formadas).

### Comandos

| Comando         | Campos                        | Respuesta OK                    | Errores típicos                                      |
| --------------- | ----------------------------- | ------------------------------- | ---------------------------------------------------- |
| `start`         | `device?: string`             | `recording`                     | `already recording`, `input device not found: …`     |
| `stop`          | `path: string` (ruta del WAV) | `saved`                         | `not recording`, `empty recording`                   |
| `cancel`        |                               | `cancelled` (aunque no grabase) |                                                      |
| `list_devices`  |                               | `devices`                       |                                                      |
| `set_hotkey`    | `combo: string`               | `ok`                            | `invalid hotkey …`, `cannot register …`, sin soporte |
| `clear_hotkey`  |                               | `ok`                            |                                                      |
| `pause_hotkey`  |                               | `ok`                            |                                                      |
| `resume_hotkey` |                               | `ok`                            | `cannot re-register hotkey: …`                       |
| `quit`          |                               | `ok` y sale                     |                                                      |

Un comando desconocido o JSON inválido produce `{"event":"error","msg":"invalid request: …"}` sin
`id`.

### Eventos

| Evento      | Campos                                         | Cuándo                                                      |
| ----------- | ---------------------------------------------- | ----------------------------------------------------------- |
| `ready`     | `version`, `hotkey_supported: bool`            | Al arrancar, antes de leer stdin                            |
| `hotkey`    |                                                | Se pulsó el atajo (solo `Pressed`, no `Released`)           |
| `recording` | `sample_rate` (nativo del micro), `device`     | Respuesta a `start`, **después** de `stream.play()`         |
| `saved`     | `path`, `duration_sec`                         | Respuesta a `stop`, con el WAV ya escrito                   |
| `cancelled` |                                                | Respuesta a `cancel`                                        |
| `devices`   | `devices: string[]`, `default: string \| null` | Respuesta a `list_devices`                                  |
| `ok`        |                                                | Respuesta genérica                                          |
| `error`     | `msg`                                          | Respuesta de error (con `id`) o error espontáneo (sin `id`) |

### Ejemplo de sesión

```
← {"event":"ready","version":"0.1.0","hotkey_supported":true}
→ {"id":1,"cmd":"set_hotkey","combo":"CmdOrCtrl+Shift+Space"}
← {"id":1,"event":"ok"}
← {"event":"hotkey"}
→ {"id":2,"cmd":"start"}
← {"id":2,"event":"recording","sample_rate":48000,"device":"Micrófono del MacBook Air"}
← {"event":"hotkey"}
→ {"id":3,"cmd":"stop","path":"/Users/damian/deno-asr-dataset/2026-09-23/20260923-013600-a1b2.wav"}
← {"id":3,"event":"saved","path":"/Users/damian/deno-asr-dataset/2026-09-23/20260923-013600-a1b2.wav","duration_sec":4.21}
```

Probarlo a mano:

```bash
printf '%s\n' '{"id":1,"cmd":"list_devices"}' | cargo run -q
```

## Grabación

- Dispositivo: el de entrada por defecto, o el que coincida exactamente por nombre con `device`
  (`""` y `"default"` equivalen a por defecto). Los nombres salen de `list_devices`.
- Se abre con la config por defecto del dispositivo (rate y canales nativos). Formatos soportados:
  `f32`, `i16`, `i32`, `u16`.
- El callback de tiempo real solo hace downmix a mono y acumula `f32` en un buffer.
- En `stop`: se cierra el stream (libera el micro), se remuestrea a 16 kHz con `rubato::Fft`, se
  convierte a `i16` con clamping y se escribe el WAV con `hound`, creando los directorios padre.
- `duration_sec` es la duración del WAV resultante.
- `cpal::Stream` no es `Send` en macOS, así que vive en un hilo `audio` dedicado que recibe comandos
  por un `mpsc`.

## Atajo global

- Formato de `combo`: el de `global-hotkey` — `CmdOrCtrl`/`Super`/`Ctrl`/`Alt`/`Shift` + un nombre
  de `KeyboardEvent.code` (`Space`, `KeyA`, `F5`…).
- `set_hotkey` reemplaza el atajo activo. Si el registro falla, se vuelve a registrar el anterior.
- `pause_hotkey` / `resume_hotkey`: desregistran/re-registran sin olvidar el atajo. Deno lo usa
  mientras el usuario graba una combinación nueva en la ventana de ajustes. Un `set_hotkey` en pausa
  solo guarda el combo; se registra al reanudar.
- `hotkey_supported` es `false` en Linux Wayland o sin `DISPLAY`: los compositores Wayland no
  permiten capturar teclas globales. Deno usa entonces un atajo de GNOME (ver el README principal).

### Hilos y event loop

| Plataforma | Hilo principal                                                | Otros hilos                         |
| ---------- | ------------------------------------------------------------- | ----------------------------------- |
| macOS      | `tao::EventLoop` (necesario para Carbon hotkeys) + `dispatch` | `stdin` → `EventLoopProxy`, `audio` |
| Linux      | bucle sobre un `mpsc` + `dispatch`                            | `stdin` → `mpsc`, `audio`           |

En macOS el event loop usa `ActivationPolicy::Prohibited` y oculta el Dock: el helper nunca aparece
como app. El permiso de micro lo pide macOS en nombre de la app que lo lanza (su `Info.plist` debe
tener `NSMicrophoneUsageDescription`).

## Módulos

| Fichero           | Contenido                                                          |
| ----------------- | ------------------------------------------------------------------ |
| `src/main.rs`     | Arranque, event loop por plataforma, `dispatch` de comandos        |
| `src/protocol.rs` | `Cmd`, `Request`, `Event`, `emit` (stdout con flush por línea)     |
| `src/recorder.rs` | Hilo de audio, apertura del stream, remuestreo y escritura del WAV |
| `src/hotkey.rs`   | Detección de soporte y gestión del atajo (`set`/`pause`/`resume`)  |
