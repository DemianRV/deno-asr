//! Wire format. Requests: `{"id":N,"cmd":"…",…}`. Events: `{"id"?:N,"event":"…",…}`;
//! events without `id` are unsolicited.

use std::io::{BufRead, Write};

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Cmd {
    Start {
        #[serde(default)]
        device: Option<String>,
    },
    Stop {
        path: String,
    },
    Cancel,
    SetHotkey {
        combo: String,
    },
    ClearHotkey,
    PauseHotkey,
    ResumeHotkey,
    ListDevices,
    Quit,
}

#[derive(Debug, Deserialize, PartialEq)]
pub struct Request {
    pub id: u64,
    #[serde(flatten)]
    pub cmd: Cmd,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    Ready {
        version: &'static str,
        hotkey_supported: bool,
    },
    Hotkey,
    Recording {
        sample_rate: u32,
        device: String,
    },
    Saved {
        path: String,
        duration_sec: f64,
    },
    Cancelled,
    Devices {
        devices: Vec<String>,
        default: Option<String>,
    },
    Ok,
    Error {
        msg: String,
    },
}

#[derive(Serialize)]
struct Envelope<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<u64>,
    #[serde(flatten)]
    event: &'a Event,
}

pub fn encode(id: Option<u64>, event: &Event) -> String {
    serde_json::to_string(&Envelope { id, event }).expect("event is always serializable")
}

/// Writes one JSON line to stdout. `StdoutLock` serializes concurrent writers.
pub fn emit(id: Option<u64>, event: Event) {
    let line = encode(id, &event);
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

pub fn emit_error(id: Option<u64>, msg: impl Into<String>) {
    emit(id, Event::Error { msg: msg.into() });
}

pub fn parse(line: &str) -> Result<Request, String> {
    serde_json::from_str(line).map_err(|e| format!("invalid request: {e}"))
}

/// Reads requests from stdin until EOF, forwarding them to `sink`.
/// Malformed lines are reported and skipped.
pub fn read_stdin(mut sink: impl FnMut(Request)) {
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match parse(line) {
            Ok(req) => sink(req),
            Err(msg) => emit_error(None, msg),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_commands() {
        assert_eq!(
            parse(r#"{"id":1,"cmd":"start"}"#).unwrap(),
            Request { id: 1, cmd: Cmd::Start { device: None } }
        );
        assert_eq!(
            parse(r#"{"id":2,"cmd":"stop","path":"/tmp/a.wav"}"#).unwrap(),
            Request { id: 2, cmd: Cmd::Stop { path: "/tmp/a.wav".into() } }
        );
        assert_eq!(
            parse(r#"{"id":3,"cmd":"set_hotkey","combo":"CmdOrCtrl+Shift+Space"}"#).unwrap(),
            Request { id: 3, cmd: Cmd::SetHotkey { combo: "CmdOrCtrl+Shift+Space".into() } }
        );
        assert!(parse(r#"{"id":4,"cmd":"nope"}"#).is_err());
        assert!(parse(r#"{"cmd":"start"}"#).is_err());
    }

    #[test]
    fn encodes_events() {
        assert_eq!(encode(None, &Event::Hotkey), r#"{"event":"hotkey"}"#);
        assert_eq!(
            encode(Some(2), &Event::Saved { path: "/tmp/a.wav".into(), duration_sec: 1.5 }),
            r#"{"id":2,"event":"saved","path":"/tmp/a.wav","duration_sec":1.5}"#
        );
        assert_eq!(
            encode(Some(3), &Event::Error { msg: "x".into() }),
            r#"{"id":3,"event":"error","msg":"x"}"#
        );
    }
}
