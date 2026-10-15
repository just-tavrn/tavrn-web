// SPDX-License-Identifier: Apache-2.0
//! Deep links into the app (docs/DESKTOP.md "Links into the app"): the scheme `tavrn://`, registered by the Windows
//! installers (tauri-plugin-deep-link), the Electron shell (`.desktop` entry, `setAsDefaultProtocolClient`) and the
//! Android app (an intent filter next to the App Links). Every link the system hands the app passes this check before
//! the client sees it; the client checks it again and shows the target before it acts (no silent navigation).
//!
//! | Link | Means |
//! |---|---|
//! | `tavrn://invite/<node>/<code>` | the invite `<code>` of the node `<node>` |
//! | `tavrn://room/<node>/<room>[/<channel>]` | a room (and channel) of `<node>` |
//! | `tavrn://add/<node>/<id>`, `tavrn://add/<node>/<domain>/<id>` with optional `?room=` | an add link of an application |
//! | `tavrn://connect?session=<id>&state=<state>` | the browser's "back to the app" after the sign-in on the node's page |
//!
//! `<node>` is the node's host as its web links name it (its identity domain or the host of its web client; the client
//! finds the identity domain): a domain name with a dot, no port, no credentials (`resolve::valid_domain`), so a
//! link never points the app at this computer or an address. `connect` carries the app session's id and the state of
//! the sign-in the app started (the rules of `guard::connect_url`); the app acts on it only when both are the pending
//! sign-in's, and it then only polls at once (the one-time code still comes from the node, exchanged with the PKCE
//! verifier). Anything else, including a fragment, an unknown parameter and a link longer than 512 bytes, is refused.

use tauri::Url;

use crate::guard::{session_id_ok, state_ok};
use crate::resolve::valid_domain;

/// The scheme of the deep links.
pub const SCHEME: &str = "tavrn";

const MAX_LINK: usize = 512;
const MAX_ROOM_PARAM: usize = 200;

/// A token of a path: an invite code, a room, channel or application id (base64url characters, `min..=64`).
pub fn token(s: &str, min: usize) -> bool {
    (min..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// A checked deep link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeepLink {
    Invite { node: String, code: String },
    Room { node: String, room: String, channel: Option<String> },
    Add { node: String, domain: Option<String>, id: String, room: Option<String> },
    Connect { session: String, state: String },
}

impl DeepLink {
    /// The link, or none when it is not one of the forms above.
    pub fn parse(input: &str) -> Option<Self> {
        if input.len() > MAX_LINK {
            return None;
        }
        let url = Url::parse(input).ok()?;
        if url.scheme() != SCHEME || url.port().is_some() || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
            return None;
        }
        let kind = url.host_str()?.to_ascii_lowercase();
        let path = url.path().strip_prefix('/').unwrap_or(url.path());
        let path = path.strip_suffix('/').unwrap_or(path);
        let segments: Vec<&str> = if path.is_empty() { Vec::new() } else { path.split('/').collect() };
        let query: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        let node = |s: &str| {
            let s = s.to_ascii_lowercase();
            valid_domain(&s).then_some(s)
        };
        match (kind.as_str(), segments.as_slice()) {
            ("invite", [n, code]) if query.is_empty() && token(code, 4) => Some(Self::Invite { node: node(n)?, code: (*code).to_string() }),
            ("room", [n, room, rest @ ..]) if query.is_empty() && rest.len() <= 1 && token(room, 1) && rest.iter().all(|c| token(c, 1)) => {
                Some(Self::Room { node: node(n)?, room: (*room).to_string(), channel: rest.first().map(|c| (*c).to_string()) })
            }
            ("add", [n, rest @ ..]) if (1..=2).contains(&rest.len()) => {
                let (domain, id) = match rest {
                    [id] => (None, *id),
                    [domain, id] => (Some(node(domain)?), *id),
                    _ => return None,
                };
                let room = match query.as_slice() {
                    [] => None,
                    [(k, v)] if k == "room" && !v.is_empty() && v.len() <= MAX_ROOM_PARAM && !v.chars().any(|c| c.is_control() || c.is_whitespace()) => {
                        Some(v.clone())
                    }
                    _ => return None,
                };
                if !token(id, 1) {
                    return None;
                }
                Some(Self::Add { node: node(n)?, domain, id: id.to_string(), room })
            }
            ("connect", []) => {
                let (mut session, mut state) = (None, None);
                for (k, v) in query {
                    match k.as_str() {
                        "session" if session.is_none() && session_id_ok(&v) => session = Some(v),
                        "state" if state.is_none() && state_ok(&v) => state = Some(v),
                        _ => return None,
                    }
                }
                Some(Self::Connect { session: session?, state: state? })
            }
            _ => None,
        }
    }

    /// The link in its one written form (lower-case hosts, no trailing slash), as the client receives it.
    pub fn to_url(&self) -> String {
        match self {
            Self::Invite { node, code } => format!("{SCHEME}://invite/{node}/{code}"),
            Self::Room { node, room, channel: None } => format!("{SCHEME}://room/{node}/{room}"),
            Self::Room { node, room, channel: Some(c) } => format!("{SCHEME}://room/{node}/{room}/{c}"),
            Self::Add { node, domain, id, room } => {
                let base = match domain {
                    Some(d) => format!("{SCHEME}://add/{node}/{d}/{id}"),
                    None => format!("{SCHEME}://add/{node}/{id}"),
                };
                match (room, Url::parse(&base)) {
                    (Some(room), Ok(mut url)) => {
                        url.query_pairs_mut().append_pair("room", room);
                        url.to_string()
                    }
                    _ => base,
                }
            }
            Self::Connect { session, state } => format!("{SCHEME}://connect?session={session}&state={state}"),
        }
    }
}

/// A `tavrn://` link the system handed the app, in the form the client receives, or none.
pub fn deep_link(input: &str) -> Option<String> {
    DeepLink::parse(input).map(|l| l.to_url())
}

/// The deep links among a program's arguments (Windows and Linux start the app, or a second instance, with the link
/// as an argument); at most a few, the rest is ignored.
pub fn from_args<I: IntoIterator<Item = S>, S: AsRef<str>>(args: I) -> Vec<String> {
    args.into_iter().filter_map(|a| a.as_ref().starts_with("tavrn:").then(|| deep_link(a.as_ref())).flatten()).take(4).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Vectors {
        accept: Vec<(String, String)>,
        refuse: Vec<String>,
    }

    /// The cases both shells test against (apps/shared-vectors/deeplink.json, also read by the Electron shell's
    /// `deeplink.test.ts`): invites, rooms and add links that name a node, the sign-in handoff with its session and
    /// state only, everything else refused.
    #[test]
    fn the_shared_vectors_of_both_shells() {
        let v: Vectors = serde_json::from_str(include_str!("../../../shared-vectors/deeplink.json")).unwrap_or_else(|e| unreachable!("vectors: {e}"));
        assert!(!v.accept.is_empty() && !v.refuse.is_empty());
        for (input, link) in &v.accept {
            assert_eq!(deep_link(input).as_deref(), Some(link.as_str()), "{input}");
        }
        for input in &v.refuse {
            assert_eq!(deep_link(input), None, "{input}");
        }
    }

    #[test]
    fn links_parse_into_their_parts() {
        assert_eq!(
            DeepLink::parse("tavrn://room/chat.example/r1/c1"),
            Some(DeepLink::Room { node: "chat.example".into(), room: "r1".into(), channel: Some("c1".into()) })
        );
    }

    #[test]
    fn links_among_the_arguments_of_a_start() {
        let args = [
            "C:\\Program Files\\Tavrn\\tavrn.exe",
            "--flag",
            "tavrn://invite/chat.example/code1234",
            "tavrn://invite/localhost/code1234",
            "https://x.example/",
        ];
        assert_eq!(from_args(args), vec!["tavrn://invite/chat.example/code1234".to_string()]);
        assert!(from_args(["tavrn"]).is_empty());
        assert_eq!(from_args(std::iter::repeat_n("tavrn://invite/chat.example/code1234", 10)).len(), 4);
    }
}
