// SPDX-License-Identifier: Apache-2.0
//! Game activity (docs/DESKTOP.md "Game activity"), opt-in: while the user has "Show the game I am playing" on, the
//! client hands the shell its list of games (`games_watch`), and the shell looks every few seconds which program is in
//! front (`keywatch::games`: the process name of the foreground window, Windows and X11). Only the display name of a
//! listed game goes back to the client, as the shell event `game` when it changes (`null` when the game closed or
//! another program came to the front); window titles, paths and the names of other programs never leave the shell. An
//! empty list stops the watch (the setting off, signed out) and reports `null` once if a game was shown.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use keywatch::games::{self, Game};
use serde::Deserialize;
use tauri::{AppHandle, Runtime, State};

use crate::events::{self, ShellEvent};

/// How often the shell looks.
pub const INTERVAL: Duration = Duration::from_secs(5);

/// An entry of the client's list.
#[derive(Debug, Clone, Deserialize)]
pub struct GameEntry {
    pub process: String,
    pub name: String,
}

/// The entries as the matcher takes them, or `games.invalid` (too many, an empty or overlong name, a path).
pub fn checked(entries: Vec<GameEntry>) -> Result<Vec<Game>, String> {
    if entries.len() > games::MAX_ENTRIES {
        return Err("games.invalid".into());
    }
    let list: Vec<Game> = entries.into_iter().map(|e| Game { process: e.process.trim().to_string(), name: e.name.trim().to_string() }).collect();
    if list.iter().all(Game::valid) { Ok(list) } else { Err("games.invalid".into()) }
}

#[derive(Default)]
struct Watch {
    list: Vec<Game>,
    running: bool,
    /// The game last reported to the client.
    shown: Option<String>,
}

/// The watch's state, shared with its thread.
#[derive(Default, Clone)]
pub struct Games(Arc<Mutex<Watch>>);

impl Games {
    /// Replaces the list; true when a thread must be started (a list and none runs yet). An empty list stops the
    /// watch: the answer's second value is the `null` to report when a game was shown.
    fn set(&self, list: Vec<Game>) -> (bool, bool) {
        let Ok(mut w) = self.0.lock() else { return (false, false) };
        let start = !list.is_empty() && !w.running;
        let cleared = list.is_empty() && w.shown.take().is_some();
        w.list = list;
        if start {
            w.running = true;
        }
        (start, cleared)
    }

    /// One look: the game to report when it changed (`Some(None)`: no game any more); `None` when the watch ended.
    fn tick(&self, found: impl FnOnce(&[Game]) -> Option<String>) -> Option<Option<Option<String>>> {
        let list = {
            let Ok(mut w) = self.0.lock() else { return None };
            if w.list.is_empty() {
                w.running = false;
                return None;
            }
            w.list.clone()
        };
        let now = found(&list);
        let Ok(mut w) = self.0.lock() else { return None };
        // The list may have been emptied meanwhile: then nothing is reported (the stop did that).
        if w.list.is_empty() {
            w.running = false;
            return None;
        }
        if w.shown == now {
            return Some(None);
        }
        w.shown.clone_from(&now);
        Some(Some(now))
    }
}

/// Starts or replaces the watch with `entries` (empty: stops it). Answers whether this system can tell the program in
/// front at all (Windows, X11); elsewhere the client says so in the setting.
#[tauri::command]
pub fn games_watch<R: Runtime>(app: AppHandle<R>, state: State<'_, Games>, entries: Vec<GameEntry>) -> Result<bool, String> {
    let list = checked(entries)?;
    let (start, cleared) = state.set(list);
    if cleared {
        events::send(&app, ShellEvent::Game { name: None });
    }
    if start {
        let games = state.inner().clone();
        std::thread::Builder::new()
            .name("tavrn-games".into())
            .spawn(move || {
                loop {
                    match games.tick(|list| games::foreground_game(list).map(|g| g.name.clone())) {
                        None => break,
                        Some(Some(name)) => events::send(&app, ShellEvent::Game { name }),
                        Some(None) => {}
                    }
                    std::thread::sleep(INTERVAL);
                }
            })
            .map_err(|_| "games.unavailable".to_string())?;
    }
    Ok(games::SUPPORTED)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(process: &str, name: &str) -> GameEntry {
        GameEntry { process: process.into(), name: name.into() }
    }

    #[test]
    fn the_list_is_checked() {
        assert_eq!(checked(vec![entry(" factorio ", " Factorio ")]), Ok(vec![Game { process: "factorio".into(), name: "Factorio".into() }]));
        assert_eq!(checked(vec![]), Ok(vec![]));
        assert_eq!(checked(vec![entry("C:\\x.exe", "X")]), Err("games.invalid".into()));
        assert_eq!(checked(vec![entry("x", "")]), Err("games.invalid".into()));
        assert_eq!(checked((0..=games::MAX_ENTRIES).map(|i| entry(&format!("g{i}"), "G")).collect()), Err("games.invalid".into()));
    }

    #[test]
    fn a_game_is_reported_when_it_changes_and_cleared_when_the_watch_stops() {
        let games = Games::default();
        let list = checked(vec![entry("factorio", "Factorio")]).unwrap_or_default();
        assert_eq!(games.set(list.clone()), (true, false), "the first list starts the thread");
        assert_eq!(games.set(list), (false, false), "a new list keeps the thread");
        assert_eq!(games.tick(|_| None), Some(None), "nothing in front, nothing shown: nothing to report");
        assert_eq!(games.tick(|_| Some("Factorio".into())), Some(Some(Some("Factorio".into()))));
        assert_eq!(games.tick(|_| Some("Factorio".into())), Some(None), "unchanged: not repeated");
        assert_eq!(games.tick(|_| None), Some(Some(None)), "the game closed");
        assert_eq!(games.tick(|_| Some("Factorio".into())), Some(Some(Some("Factorio".into()))));
        assert_eq!(games.set(Vec::new()), (false, true), "turned off while a game was shown: report null once");
        assert_eq!(games.tick(|_| Some("Factorio".into())), None, "the thread ends");
        assert_eq!(games.set(Vec::new()), (false, false));
        assert_eq!(games.set(checked(vec![entry("factorio", "Factorio")]).unwrap_or_default()), (true, false), "a new thread after the end");
    }

    #[test]
    fn the_watcher_sees_names_only_through_the_list() {
        // The shell hands the matcher the list and reports nothing but a listed game's display name.
        let games = Games::default();
        games.set(checked(vec![entry("eldenring.exe", "ELDEN RING")]).unwrap_or_default());
        let report = games.tick(|list| keywatch::games::matched(&["firefox".to_string()], list).map(|g| g.name.clone()));
        assert_eq!(report, Some(None));
        let report = games.tick(|list| keywatch::games::matched(&["EldenRing.exe".to_string()], list).map(|g| g.name.clone()));
        assert_eq!(report, Some(Some(Some("ELDEN RING".into()))));
    }
}
