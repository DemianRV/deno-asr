//! asr-helper: microphone recording and global hotkey for deno-asr, driven over
//! JSON lines on stdin/stdout (see README.md). Exits on stdin EOF.

mod hotkey;
mod protocol;
mod recorder;

use hotkey::Hotkeys;
use protocol::{Cmd, Event, Request, emit, emit_error};
use recorder::Recorder;

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Handles one request. Must run on the thread that owns `Hotkeys`.
/// Returns `false` when the helper should exit.
fn dispatch(req: Request, hotkeys: &mut Hotkeys, recorder: &Recorder) -> bool {
    let Request { id, cmd } = req;
    match cmd {
        Cmd::Start { device } => recorder.start(id, device),
        Cmd::Stop { path } => recorder.stop(id, path),
        Cmd::Cancel => recorder.cancel(id),
        Cmd::ListDevices => recorder.list_devices(id),
        Cmd::SetHotkey { combo } => reply(id, hotkeys.set(&combo)),
        Cmd::ClearHotkey => {
            hotkeys.clear();
            emit(Some(id), Event::Ok);
        }
        Cmd::PauseHotkey => {
            hotkeys.pause();
            emit(Some(id), Event::Ok);
        }
        Cmd::ResumeHotkey => reply(id, hotkeys.resume()),
        Cmd::Quit => {
            emit(Some(id), Event::Ok);
            return false;
        }
    }
    true
}

fn reply(id: u64, result: Result<(), String>) {
    match result {
        Ok(()) => emit(Some(id), Event::Ok),
        Err(msg) => emit_error(Some(id), msg),
    }
}

fn spawn_stdin_reader(forward: impl Fn(Request) -> bool + Send + 'static) {
    std::thread::Builder::new()
        .name("stdin".into())
        .spawn(move || {
            protocol::read_stdin(|req| {
                if !forward(req) {
                    std::process::exit(0);
                }
            });
            // Parent closed our stdin (or died): exit so we never linger holding the mic.
            std::process::exit(0);
        })
        .expect("failed to spawn stdin thread");
}

#[cfg(target_os = "macos")]
fn main() {
    use tao::event::Event as TaoEvent;
    use tao::event_loop::{ControlFlow, EventLoopBuilder};
    use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};

    let mut event_loop = EventLoopBuilder::<Request>::with_user_event().build();
    event_loop.set_activation_policy(ActivationPolicy::Prohibited);
    event_loop.set_dock_visibility(false);

    let proxy = event_loop.create_proxy();
    let recorder = Recorder::spawn();
    let mut hotkeys = Hotkeys::new();

    emit(None, Event::Ready { version: VERSION, hotkey_supported: hotkeys.is_supported() });
    spawn_stdin_reader(move |req| proxy.send_event(req).is_ok());

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        if let TaoEvent::UserEvent(req) = event {
            if !dispatch(req, &mut hotkeys, &recorder) {
                *control_flow = ControlFlow::Exit;
            }
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn main() {
    let (tx, rx) = std::sync::mpsc::channel::<Request>();
    let recorder = Recorder::spawn();
    let mut hotkeys = Hotkeys::new();

    emit(None, Event::Ready { version: VERSION, hotkey_supported: hotkeys.is_supported() });
    spawn_stdin_reader(move |req| tx.send(req).is_ok());

    for req in rx {
        if !dispatch(req, &mut hotkeys, &recorder) {
            break;
        }
    }
}
