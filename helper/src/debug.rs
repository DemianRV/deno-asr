//! Opt-in stderr tracing, driven by the same `ASR_DEBUG` variable as the Deno side:
//! `*` / `1` enables everything, otherwise a comma list of namespaces (`rec`).

use std::sync::OnceLock;

pub fn enabled(ns: &str) -> bool {
    static SPEC: OnceLock<Vec<String>> = OnceLock::new();
    let spec = SPEC.get_or_init(|| parse(&std::env::var("ASR_DEBUG").unwrap_or_default()));
    spec.iter().any(|s| s == "*" || s == "1" || s == ns)
}

pub fn parse(value: &str) -> Vec<String> {
    value.split(',').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect()
}

/// `debug!("rec", "opened {name}")` → `[asr-helper:rec] opened …` on stderr.
macro_rules! debug {
    ($ns:literal, $($arg:tt)*) => {
        if $crate::debug::enabled($ns) {
            eprintln!("[asr-helper:{}] {}", $ns, format_args!($($arg)*));
        }
    };
}

pub(crate) use debug;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_spec() {
        assert_eq!(parse(""), Vec::<String>::new());
        assert_eq!(parse(" rec , helper,"), vec!["rec", "helper"]);
    }
}
