// SPDX-License-Identifier: Apache-2.0
//! What the main window may show: only the bundled client. The app never loads remote pages, so a node can never
//! reach the native API. Navigations elsewhere are refused; web links (http, https, mailto) open in the system
//! browser instead. The click-to-play embeds of the client (CSP `frame-src`) load in their frames.
//!
//! The sign-in window (`connect`, docs/DESKTOP.md "Signing in") shows the node's own `/connect` page and wherever single
//! sign-on sends it: https pages (plain http only on this computer), never the bundled client and never `tauri:`,
//! `file:`, `data:`, `javascript:` or `blob:` URLs. It has no capability, so no page in it reaches the native API.

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

/// Hosts reached over plain http: a node in development mode on this computer (as `node_url.rs`).
const DEV_HOSTS: [&str; 2] = ["localhost", "127.0.0.1"];

/// The decision for a navigation of the sign-in window or one of its frames.
pub fn connect_navigation(url: &Url, dev_url: Option<&Url>) -> Navigation {
    if is_app_url(url, dev_url) {
        return Navigation::Deny;
    }
    let host = url.host_str().unwrap_or_default();
    match url.scheme() {
        "https" if !host.is_empty() => Navigation::Allow,
        "http" if DEV_HOSTS.contains(&host) => Navigation::Allow,
        "about" if matches!(url.path(), "blank" | "srcdoc") => Navigation::Allow,
        "http" | "mailto" => Navigation::External(url.to_string()),
        _ => Navigation::Deny,
    }
}

/// Why `open_connect` refused a URL.
#[derive(Debug, PartialEq, Eq)]
pub enum ConnectUrlError {
    Invalid,
    /// Not the chosen node's web client.
    OtherOrigin,
}

/// `open_connect` command: the chosen node's sign-in page for an app session,
/// `<web origin>/connect?session=<43 characters of base64url>[&state=…][&mode=register][&method=passkey|sso]` with an
/// optional fragment `#k=<43 characters of base64url>` (the app's key for sealed unlock material, FEDERATION.md §8
/// step 3), nothing else.
pub fn connect_url(url: &str, web: &str) -> Result<Url, ConnectUrlError> {
    let url = Url::parse(url).map_err(|_| ConnectUrlError::Invalid)?;
    let web = Url::parse(web).map_err(|_| ConnectUrlError::Invalid)?;
    if url.origin() != web.origin() || !matches!(url.scheme(), "https" | "http") {
        return Err(ConnectUrlError::OtherOrigin);
    }
    if url.scheme() == "http" && !DEV_HOSTS.contains(&url.host_str().unwrap_or_default()) {
        return Err(ConnectUrlError::Invalid);
    }
    let b64url_43 = |v: &str| v.len() == 43 && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    let fragment_ok = url.fragment().is_none_or(|f| f.strip_prefix("k=").is_some_and(b64url_43));
    if url.path() != "/connect" || !fragment_ok || !url.username().is_empty() || url.password().is_some() {
        return Err(ConnectUrlError::Invalid);
    }
    let (mut session, mut method) = (false, false);
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "session" if b64url_43(&value) && !session => session = true,
            "state" if (16..=128).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') => {}
            "mode" if value == "register" => {}
            "method" if matches!(value.as_ref(), "passkey" | "sso") && !method => method = true,
            _ => return Err(ConnectUrlError::Invalid),
        }
    }
    if session { Ok(url) } else { Err(ConnectUrlError::Invalid) }
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
    fn the_sign_in_window_follows_the_node_and_single_sign_on_but_never_the_app() {
        for ok in [
            "https://tavrn.example/connect?session=x",
            "https://login.idp.example/authorize?client_id=x",
            "http://127.0.0.1:8500/connect",
            "http://localhost:8080/sso/callback",
            "about:blank",
        ] {
            assert_eq!(connect_navigation(&u(ok), None), Navigation::Allow, "{ok}");
        }
        for bad in [
            "tauri://localhost/",
            "https://tauri.localhost/login",
            "http://tauri.localhost/",
            "file:///etc/passwd",
            "data:text/html,hi",
            "javascript:alert(1)",
            "blob:https://tavrn.example/abc",
            "ftp://x.example/",
        ] {
            assert_eq!(connect_navigation(&u(bad), None), Navigation::Deny, "{bad}");
        }
        assert_eq!(connect_navigation(&u("http://evil.example/"), None), Navigation::External("http://evil.example/".into()));
        let dev = u("http://localhost:5173");
        assert_eq!(connect_navigation(&u("http://localhost:5173/rooms"), Some(&dev)), Navigation::Deny, "the dev server is the app");
    }

    #[test]
    fn open_connect_takes_only_the_nodes_sign_in_page() {
        let s = "S".repeat(43);
        let state = "s".repeat(22);
        let web = "https://web.tavrn.example";
        // The app's key for sealed unlock material (32 bytes, base64url).
        let k = "K".repeat(43);
        for ok in [
            format!("{web}/connect?session={s}"),
            format!("{web}/connect?session={s}&state={state}"),
            format!("{web}/connect?session={s}&state={state}&mode=register"),
            format!("{web}/connect?session={s}&state={state}&method=passkey"),
            format!("{web}/connect?session={s}&state={state}&method=sso"),
            format!("{web}/connect?session={s}&state={state}&method=passkey#k={k}"),
            format!("{web}/connect?session={s}&mode=register#k={k}"),
        ] {
            assert!(connect_url(&ok, web).is_ok(), "{ok}");
        }
        assert!(connect_url(&format!("http://127.0.0.1:8500/connect?session={s}"), "http://127.0.0.1:8500").is_ok());
        for (bad, why) in [
            (format!("https://evil.example/connect?session={s}"), ConnectUrlError::OtherOrigin),
            (format!("https://web.tavrn.example:8443/connect?session={s}"), ConnectUrlError::OtherOrigin),
            (format!("http://web.tavrn.example/connect?session={s}"), ConnectUrlError::OtherOrigin),
            (format!("tauri://localhost/connect?session={s}"), ConnectUrlError::OtherOrigin),
            (format!("{web}/login?session={s}"), ConnectUrlError::Invalid),
            (format!("{web}/connect?session=short"), ConnectUrlError::Invalid),
            (format!("{web}/connect"), ConnectUrlError::Invalid),
            (format!("{web}/connect?session={s}&origin=https://evil.example"), ConnectUrlError::Invalid),
            (format!("{web}/connect?session={s}&session={s}"), ConnectUrlError::Invalid),
            (format!("{web}/connect?session={s}#x"), ConnectUrlError::Invalid),
            (format!("{web}/connect?session={s}#k=short"), ConnectUrlError::Invalid),
            (format!("{web}/connect?session={s}#k={k}&x=1"), ConnectUrlError::Invalid),
            (format!("{web}/connect?session={s}#k={}", "+".repeat(43)), ConnectUrlError::Invalid),
            (format!("{web}/connect?session={s}&method=password"), ConnectUrlError::Invalid),
            (format!("{web}/connect?session={s}&method=passkey&method=sso"), ConnectUrlError::Invalid),
            ("javascript:alert(1)".into(), ConnectUrlError::OtherOrigin),
        ] {
            assert_eq!(connect_url(&bad, web).map(|_| ()), Err(why), "{bad}");
        }
        assert_eq!(connect_url(&format!("http://192.168.1.2/connect?session={s}"), "http://192.168.1.2").map(|_| ()), Err(ConnectUrlError::Invalid));
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
