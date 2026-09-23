//! Single global hotkey via `global-hotkey`. Presses are emitted as `{"event":"hotkey"}`.

use std::str::FromStr;

use global_hotkey::hotkey::HotKey;
use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};

use crate::protocol::{Event, emit};

/// `global-hotkey` supports macOS, Windows and X11. Wayland compositors
/// don't allow clients to grab keys, so the desktop shortcut is used instead.
pub fn supported() -> bool {
    if cfg!(target_os = "linux") {
        let wayland = std::env::var("XDG_SESSION_TYPE").is_ok_and(|t| t.eq_ignore_ascii_case("wayland"))
            || std::env::var_os("WAYLAND_DISPLAY").is_some();
        let x11 = std::env::var_os("DISPLAY").is_some();
        return x11 && !wayland;
    }
    true
}

/// Must be created on the thread that runs the platform event loop
/// (the main thread on macOS).
pub struct Hotkeys {
    manager: Option<GlobalHotKeyManager>,
    current: Option<HotKey>,
    paused: bool,
}

impl Hotkeys {
    pub fn new() -> Self {
        let manager = if supported() {
            match GlobalHotKeyManager::new() {
                Ok(m) => Some(m),
                Err(e) => {
                    crate::protocol::emit_error(None, format!("hotkey manager unavailable: {e}"));
                    None
                }
            }
        } else {
            None
        };

        GlobalHotKeyEvent::set_event_handler(Some(|e: GlobalHotKeyEvent| {
            if e.state == HotKeyState::Pressed {
                emit(None, Event::Hotkey);
            }
        }));

        Self { manager, current: None, paused: false }
    }

    pub fn is_supported(&self) -> bool {
        self.manager.is_some()
    }

    /// Replaces the active hotkey. On failure the previous one stays registered.
    pub fn set(&mut self, combo: &str) -> Result<(), String> {
        let manager = self.manager.as_ref().ok_or("global hotkeys are not supported on this session")?;
        let next = HotKey::from_str(combo).map_err(|e| format!("invalid hotkey '{combo}': {e}"))?;

        if self.current == Some(next) {
            return Ok(());
        }
        if !self.paused {
            if let Some(prev) = self.current {
                let _ = manager.unregister(prev);
            }
            if let Err(e) = manager.register(next) {
                if let Some(prev) = self.current {
                    let _ = manager.register(prev);
                }
                return Err(format!("cannot register '{combo}': {e}"));
            }
        }
        self.current = Some(next);
        Ok(())
    }

    pub fn clear(&mut self) {
        if let (Some(manager), Some(prev)) = (&self.manager, self.current.take()) {
            if !self.paused {
                let _ = manager.unregister(prev);
            }
        }
    }

    pub fn pause(&mut self) {
        if self.paused {
            return;
        }
        if let (Some(manager), Some(hk)) = (&self.manager, self.current) {
            let _ = manager.unregister(hk);
        }
        self.paused = true;
    }

    pub fn resume(&mut self) -> Result<(), String> {
        if !self.paused {
            return Ok(());
        }
        self.paused = false;
        if let (Some(manager), Some(hk)) = (&self.manager, self.current) {
            manager.register(hk).map_err(|e| format!("cannot re-register hotkey: {e}"))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_browser_codes() {
        for combo in ["CmdOrCtrl+Shift+Space", "Ctrl+Alt+KeyR", "Super+F5", "Alt+Digit1", "Shift+Backquote"] {
            assert!(HotKey::from_str(combo).is_ok(), "{combo}");
        }
        assert!(HotKey::from_str("Ctrl+Nope").is_err());
    }
}
