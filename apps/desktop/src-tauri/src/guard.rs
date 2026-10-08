// SPDX-License-Identifier: Apache-2.0
//! What the main window may show: only the bundled client. The app never loads remote pages, so a node can never
//! reach the native API. Navigations elsewhere are refused; web links (http, https, mailto) open in the system
//! browser instead. The click-to-play embeds of the client (CSP `frame-src`) load in their frames.

use tauri::Url;

/// Hosts of the click-to-play embeds (`web/src/lib/embeds.ts`, CSP `frame-src` in tauri.conf.json): their frames
/// navigate inside the page (on Linux the navigation handler sees frame navigations too).
pub const EMBED_HOSTS: [&str; 5] = ["www.youtube-nocookie.com", "player.twitch.tv", "clips.twitch.tv", "player.vimeo.com", "open.spotify.com"];

#[derive(Debug, PartialEq, Eq)]
pub enum Navigation {
    /// The bundled client, an embed frame or an empty frame.
    Allow,
    /// Refused here, opened in the system browser.
    External(String),
    /// Refused.
    Deny,
}

/// The origin the bundled client is served from: `tauri://localhost` (Linux, macOS), `https://tauri.localhost`
/// (Windows), or the Vite dev server in development (`dev_url`).
pub fn is_app_url(url: &Url, dev_url: Option<&Url>) -> bool {
    let host = url.host_str().unwrap_or_default();
    match url.scheme() {
        "tauri" => host == "localhost",
        "https" | "http" if host == "tauri.localhost" => true,
        _ => dev_url.is_some_and(|dev| dev.origin() == url.origin()),
    }
}

/// The decision for a navigation of the main window or one of its frames.
pub fn navigation(url: &Url, dev_url: Option<&Url>) -> Navigation {
    if is_app_url(url, dev_url) {
        return Navigation::Allow;
    }
    match url.scheme() {
        "about" if matches!(url.path(), "blank" | "srcdoc") => Navigation::Allow,
        "https" if EMBED_HOSTS.contains(&url.host_str().unwrap_or_default()) => Navigation::Allow,
        _ => external(url).map_or(Navigation::Deny, Navigation::External),
    }
}

/// New windows (`window.open`, `target=_blank`) are never opened by the app; web links go to the system browser.
pub fn new_window(url: &Url) -> Option<String> {
    external(url)
}

/// A link the system browser may open: http, https, mailto.
pub fn external(url: &Url) -> Option<String> {
    matches!(url.scheme(), "http" | "https" | "mailto").then(|| url.to_string())
}

/// `open_external` command: only absolute http, https and mailto links.
pub fn external_str(url: &str) -> Option<String> {
    Url::parse(url).ok().as_ref().and_then(external)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap_or_else(|e| unreachable!("{s}: {e}"))
    }

    #[test]
    fn the_bundled_client_is_the_app() {
        for ok in ["tauri://localhost/", "tauri://localhost/rooms/1", "https://tauri.localhost/login", "http://tauri.localhost/"] {
            assert!(is_app_url(&u(ok), None), "{ok}");
        }
        for bad in ["tauri://evil/", "https://tavrn.example/", "https://tauri.localhost.evil.example/", "http://localhost:5173/"] {
            assert!(!is_app_url(&u(bad), None), "{bad}");
        }
    }

    #[test]
    fn the_dev_server_only_in_development() {
        let dev = u("http://localhost:5173");
        assert!(is_app_url(&u("http://localhost:5173/node"), Some(&dev)));
        assert!(!is_app_url(&u("http://localhost:5174/"), Some(&dev)));
        assert!(!is_app_url(&u("http://localhost:5173/"), None));
    }

    #[test]
    fn navigations_away_from_the_client_open_in_the_system_browser() {
        assert_eq!(navigation(&u("tauri://localhost/login"), None), Navigation::Allow);
        assert_eq!(navigation(&u("https://tavrn.example/invite/abc"), None), Navigation::External("https://tavrn.example/invite/abc".into()));
        assert_eq!(navigation(&u("mailto:abuse@tavrn.example"), None), Navigation::External("mailto:abuse@tavrn.example".into()));
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "ftp://x.example/", "tauri://evil/"] {
            assert_eq!(navigation(&u(bad), None), Navigation::Deny, "{bad}");
        }
    }

    #[test]
    fn embed_frames_and_empty_frames_load() {
        for ok in ["https://www.youtube-nocookie.com/embed/x", "https://player.vimeo.com/video/1", "about:blank", "about:srcdoc"] {
            assert_eq!(navigation(&u(ok), None), Navigation::Allow, "{ok}");
        }
        assert_eq!(navigation(&u("http://www.youtube-nocookie.com/embed/x"), None), Navigation::External("http://www.youtube-nocookie.com/embed/x".into()));
    }

    #[test]
    fn new_windows_never_open_in_the_app() {
        assert_eq!(new_window(&u("https://example.org/")), Some("https://example.org/".into()));
        assert_eq!(new_window(&u("tauri://localhost/rooms")), None);
        assert_eq!(new_window(&u("file:///etc/passwd")), None);
    }

    #[test]
    fn open_external_accepts_web_links_only() {
        assert_eq!(external_str("https://example.org/a?b#c"), Some("https://example.org/a?b#c".into()));
        assert_eq!(external_str("mailto:x@example.org"), Some("mailto:x@example.org".into()));
        for bad in ["", "/relative", "javascript:alert(1)", "file:///etc/passwd", "smb://host/share", "tauri://localhost/"] {
            assert_eq!(external_str(bad), None, "{bad}");
        }
    }
}
