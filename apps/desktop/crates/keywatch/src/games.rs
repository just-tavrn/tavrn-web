// SPDX-License-Identifier: Apache-2.0
//! Game activity (docs/DESKTOP.md "Game activity"): which game of a list runs in front. The shells ask
//! [`foreground_game`] every few seconds while the user has switched "Show the game I am playing" on; the list (a
//! built-in one plus the user's own entries, visible and editable in the client) names programs by their **process
//! name**. Only a game's display name of that list leaves this module: never a window title, a path or the name of
//! any other program.
//!
//! | Platform | The program in front |
//! |---|---|
//! | Windows | `GetForegroundWindow`, its process (`QueryFullProcessImageNameW`), the file name of the executable |
//! | Linux (X11, and X11 programs under XWayland) | `_NET_ACTIVE_WINDOW` of the root window, its `_NET_WM_PID`, the file name of `/proc/<pid>/exe` and the process's `comm` (Wine and Proton name it after the Windows executable) |
//! | others, native Wayland windows | nothing |

/// The most entries a list may have.
pub const MAX_ENTRIES: usize = 300;
/// The longest process name and display name.
pub const MAX_PROCESS: usize = 64;
pub const MAX_NAME: usize = 128;
/// Linux keeps 15 bytes of a process name in `comm` (`TASK_COMM_LEN` 16 with the terminating zero).
const COMM_LEN: usize = 15;

/// A game of the list: the process name to look for (`eldenring.exe`, `factorio`) and the name to show.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Game {
    pub process: String,
    pub name: String,
}

impl Game {
    /// A valid entry: a plain file name (no path, no control characters) of at most 64 bytes and a display name of
    /// at most 128 characters, neither empty.
    pub fn valid(&self) -> bool {
        let p = self.process.trim();
        let n = self.name.trim();
        !p.is_empty()
            && p.len() <= MAX_PROCESS
            && !p.chars().any(|c| c.is_control() || c == '/' || c == '\\')
            && !n.is_empty()
            && n.chars().count() <= MAX_NAME
            && !n.chars().any(char::is_control)
    }
}

/// A process name as compared: lower case, without a directory and without `.exe`.
pub fn normalize(process: &str) -> String {
    let base = process.rsplit(['/', '\\']).next().unwrap_or(process).trim().to_lowercase();
    base.strip_suffix(".exe").map(str::to_string).unwrap_or(base)
}

/// The game of `games` whose process is one of `names` (the program in front: its executable's file name and, on
/// Linux, its `comm`, which may be cut at 15 bytes), or none.
pub fn matched<'a>(names: &[String], games: &'a [Game]) -> Option<&'a Game> {
    names.iter().filter(|n| !n.trim().is_empty()).find_map(|candidate| {
        let lower = candidate.trim().to_lowercase();
        let norm = normalize(candidate);
        games.iter().find(|g| {
            let process = g.process.trim().to_lowercase();
            normalize(&process) == norm || (lower.len() == COMM_LEN && process.len() > COMM_LEN && process.starts_with(&lower))
        })
    })
}

/// The game of `games` in front now, or none (nothing matches, no window has the focus, or the platform cannot tell).
pub fn foreground_game(games: &[Game]) -> Option<&Game> {
    if games.is_empty() {
        return None;
    }
    matched(&foreground_names(), games)
}

/// The names of the program in front (see the table above); empty when unknown.
pub fn foreground_names() -> Vec<String> {
    #[cfg(target_os = "linux")]
    return crate::x11::foreground_names();
    #[cfg(windows)]
    return crate::windows::foreground_names();
    #[cfg(not(any(target_os = "linux", windows)))]
    Vec::new()
}

/// Whether this platform can tell the program in front at all.
pub const SUPPORTED: bool = cfg!(any(target_os = "linux", windows));

#[cfg(test)]
mod tests {
    use super::*;

    fn g(process: &str, name: &str) -> Game {
        Game { process: process.into(), name: name.into() }
    }

    fn names(n: &[&str]) -> Vec<String> {
        n.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn entries_are_plain_process_names_and_short_display_names() {
        assert!(g("eldenring.exe", "ELDEN RING").valid());
        assert!(g("factorio", "Factorio").valid());
        for bad in [
            g("", "x"),
            g("  ", "x"),
            g("x", ""),
            g("C:\\Games\\x.exe", "x"),
            g("/usr/bin/x", "x"),
            g("a\nb", "x"),
            g(&"a".repeat(65), "x"),
            g("x", &"n".repeat(129)),
            g("x", "a\u{7}b"),
        ] {
            assert!(!bad.valid(), "{bad:?}");
        }
        assert!(g("x", &"ä".repeat(128)).valid(), "characters, not bytes");
    }

    #[test]
    fn names_compare_without_case_directory_and_exe() {
        assert_eq!(normalize("C:\\Games\\EldenRing.EXE"), "eldenring");
        assert_eq!(normalize("/opt/factorio/bin/x64/factorio"), "factorio");
        let games = [g("eldenring.exe", "ELDEN RING"), g("factorio", "Factorio"), g("Cyberpunk2077.exe", "Cyberpunk 2077")];
        assert_eq!(matched(&names(&["eldenring.exe"]), &games).map(|g| g.name.as_str()), Some("ELDEN RING"));
        assert_eq!(matched(&names(&["ELDENRING"]), &games).map(|g| g.name.as_str()), Some("ELDEN RING"));
        assert_eq!(matched(&names(&["factorio"]), &games).map(|g| g.name.as_str()), Some("Factorio"));
        assert_eq!(matched(&names(&["factorio.exe"]), &games).map(|g| g.name.as_str()), Some("Factorio"));
    }

    #[test]
    fn a_cut_comm_finds_a_long_name_and_nothing_else() {
        let games = [g("Cyberpunk2077.exe", "Cyberpunk 2077"), g("eldenring.exe", "ELDEN RING")];
        // Proton: the executable is wine's preloader, comm the Windows executable's name cut at 15 bytes.
        assert_eq!(matched(&names(&["wine64-preloader", "Cyberpunk2077.e"]), &games).map(|g| g.name.as_str()), Some("Cyberpunk 2077"));
        // Only a name of exactly 15 bytes counts as cut; a shorter prefix is another program.
        assert_eq!(matched(&names(&["Cyberpunk"]), &games), None);
        assert_eq!(matched(&names(&["eldenrin"]), &games), None);
    }

    #[test]
    fn nothing_in_front_or_nothing_listed_is_no_game() {
        let games = [g("factorio", "Factorio")];
        assert_eq!(matched(&[], &games), None);
        assert_eq!(matched(&names(&["", "  "]), &games), None);
        assert_eq!(matched(&names(&["firefox", "bash"]), &games), None);
        assert_eq!(foreground_game(&[]), None);
    }
}
