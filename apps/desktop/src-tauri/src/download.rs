// SPDX-License-Identifier: Apache-2.0
//! Downloads (docs/DESKTOP.md "Downloads"). The webview does nothing with the client's blob downloads, so the client
//! saves files through the shell (`web/src/platform/tauriFiles.ts`):
//!
//! - `save_file_begin(name, size)` shows the native save dialog (the name is only its suggestion) and answers with the
//!   save's id, or `cancelled`;
//! - `save_file_chunk` appends one raw IPC body (header `x-tavrn-save: <id>`) to a temporary file next to the target;
//! - `save_file_end(id)` checks the size and renames the temporary file into place; `save_file_abort(id)` removes it;
//! - `save_file_reveal(id)` shows a finished file in its folder.
//!
//! The shell owns every path: the webview never names one (only a file name to suggest, and the save's id), nothing is
//! written outside the directory the user chose, and no file system plugin is exposed to the webview.
//!
//! A safety net catches downloads the webview starts by itself (an `<a download>` or a navigation that still exists):
//! the webview writes into the app's cache, then the same save dialog asks where the file goes ([`webview_download`]).
//!
//! Test hook: with `TAVRN_DESKTOP_TEST_SAVE_DIR=<dir>` set when the app starts, no dialog is shown and files are saved
//! into that directory (the WebDriver smoke test downloads a file this way). Never set it otherwise.

use std::collections::{HashMap, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};
use tauri::webview::DownloadEvent;
use tauri::{AppHandle, Manager, Runtime, State, Url, Webview};
use tauri_plugin_dialog::DialogExt;

/// The environment variable of the test hook.
pub const TEST_SAVE_DIR_ENV: &str = "TAVRN_DESKTOP_TEST_SAVE_DIR";
/// Header of a chunk that names its save.
pub const SAVE_HEADER: &str = "x-tavrn-save";
/// Saves that may run at the same time.
pub const MAX_ACTIVE: usize = 8;
/// Finished saves that "show in folder" still finds.
const MAX_SAVED: usize = 32;
/// Longest file name (bytes) the shell suggests or writes.
const MAX_NAME_BYTES: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadError {
    /// No running save has this id.
    Unknown,
    /// A save with this id runs already.
    Duplicate,
    /// Too many saves run at once.
    Busy,
    /// More bytes than announced.
    TooLarge,
    /// Fewer bytes than announced.
    Incomplete,
    /// A chunk without a raw body or without the save's header.
    InvalidBody,
    /// The file could not be written.
    WriteFailed,
    /// The save dialog failed.
    Dialog,
}

impl DownloadError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Unknown => "download.unknown",
            Self::Duplicate => "download.duplicate",
            Self::Busy => "download.busy",
            Self::TooLarge => "download.too_large",
            Self::Incomplete => "download.incomplete",
            Self::InvalidBody => "download.invalid_body",
            Self::WriteFailed => "download.write_failed",
            Self::Dialog => "download.dialog_failed",
        }
    }
}

impl From<DownloadError> for String {
    fn from(e: DownloadError) -> Self {
        e.code().to_string()
    }
}

/// A file name the shell can suggest and write: the last path component, without control characters, characters
/// Windows refuses, leading dots, trailing dots and spaces, or reserved device names; at most [`MAX_NAME_BYTES`]
/// bytes (the extension kept); `download` when nothing is left.
pub fn safe_file_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let cleaned: String = last.chars().map(|c| if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') { '_' } else { c }).collect();
    let trimmed = cleaned.trim_start_matches(['.', ' ']).trim_end_matches(['.', ' ']);
    let mut out = truncate_keeping_extension(trimmed, MAX_NAME_BYTES);
    let stem = out.split('.').next().unwrap_or_default().trim_end().to_ascii_uppercase();
    const RESERVED: [&str; 4] = ["CON", "PRN", "AUX", "NUL"];
    let numbered = |p: &str| stem.len() == 4 && stem.starts_with(p) && stem.as_bytes()[3].is_ascii_digit();
    if RESERVED.contains(&stem.as_str()) || numbered("COM") || numbered("LPT") {
        out.insert(0, '_');
    }
    if out.is_empty() { "download".to_string() } else { out }
}

fn truncate_keeping_extension(name: &str, max: usize) -> String {
    if name.len() <= max {
        return name.to_string();
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && ext.len() <= 16 => (stem, format!(".{ext}")),
        _ => (name, String::new()),
    };
    let mut cut = max.saturating_sub(ext.len());
    while !stem.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}{ext}", &stem[..cut])
}

/// The extension of a file name for the dialog's filter (1 to 10 ASCII letters or digits), if any.
pub fn extension(name: &str) -> Option<String> {
    let (stem, ext) = name.rsplit_once('.')?;
    (!stem.is_empty() && (1..=10).contains(&ext.len()) && ext.chars().all(|c| c.is_ascii_alphanumeric())).then(|| ext.to_ascii_lowercase())
}

/// `dir/name`, or `dir/name (1).ext`, `(2)`, … when that file exists (the test hook and the safety net never overwrite).
pub fn unique_target(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem, format!(".{ext}")),
        _ => (name, String::new()),
    };
    (1..).map(|n| dir.join(format!("{stem} ({n}){ext}"))).find(|p| !p.exists()).unwrap_or(first)
}

/// The cause of a failed write goes to stderr once, where the error code is chosen (the client only sees the code).
fn write_failed(what: &str, e: &io::Error) -> DownloadError {
    eprintln!("tavrn: a download could not be saved ({what}): {e}");
    DownloadError::WriteFailed
}

/// One file being written: a temporary file next to the target, renamed into place when all announced bytes arrived.
#[derive(Debug)]
pub struct ChunkWriter {
    target: PathBuf,
    temp: PathBuf,
    file: Option<File>,
    size: u64,
    written: u64,
}

impl ChunkWriter {
    /// Creates the temporary file (a new file, never an existing one) in the target's directory.
    pub fn begin(target: PathBuf, size: u64) -> io::Result<Self> {
        let dir = target.parent().filter(|d| !d.as_os_str().is_empty()).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no directory"))?;
        let name = target.file_name().and_then(|n| n.to_str()).unwrap_or("download");
        let base = truncate_keeping_extension(name, MAX_NAME_BYTES);
        for n in 0..100u32 {
            let temp = dir.join(format!(".{base}.{}-{n}.part", std::process::id()));
            match OpenOptions::new().write(true).create_new(true).open(&temp) {
                Ok(file) => return Ok(Self { target, temp, file: Some(file), size, written: 0 }),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
        Err(io::Error::new(io::ErrorKind::AlreadyExists, "no free temporary name"))
    }

    pub fn temp_path(&self) -> &Path {
        &self.temp
    }

    /// Appends `bytes`; refuses more than the announced size (the save stays running, the caller aborts it).
    pub fn write(&mut self, bytes: &[u8]) -> Result<(), DownloadError> {
        let len = bytes.len() as u64;
        if self.written.checked_add(len).is_none_or(|total| total > self.size) {
            return Err(DownloadError::TooLarge);
        }
        let file = self.file.as_mut().ok_or(DownloadError::WriteFailed)?;
        file.write_all(bytes).map_err(|e| write_failed("write", &e))?;
        self.written += len;
        Ok(())
    }

    /// Flushes the file to disk and renames it into place; returns the target.
    pub fn finish(mut self) -> Result<PathBuf, DownloadError> {
        self.finish_in_place()
    }

    /// [`Self::finish`] through a shared handle: afterwards the writer is spent (dropping it keeps the file); after a
    /// failure dropping it removes the temporary file.
    fn finish_in_place(&mut self) -> Result<PathBuf, DownloadError> {
        if self.written != self.size {
            return Err(DownloadError::Incomplete);
        }
        let file = self.file.take().ok_or(DownloadError::WriteFailed)?;
        file.sync_all().map_err(|e| write_failed("flush", &e))?;
        drop(file);
        fs::rename(&self.temp, &self.target).map_err(|e| write_failed("rename", &e))?;
        Ok(std::mem::take(&mut self.target))
    }

    /// Removes the temporary file (also what dropping an unfinished writer does).
    pub fn abort(self) {}
}

impl Drop for ChunkWriter {
    /// An unfinished save removes its temporary file (a finished one has handed its target out).
    fn drop(&mut self) {
        drop(self.file.take());
        if !self.target.as_os_str().is_empty() {
            let _ = fs::remove_file(&self.temp);
        }
    }
}

/// A running save; its own lock serializes its chunks (other saves never wait for it).
type Writer = Arc<Mutex<ChunkWriter>>;

/// The running and the recently finished saves. The registry's lock is held only to look a save up, never while a
/// file is written or flushed: the I/O runs on the blocking pool (the commands below), under the save's own lock.
#[derive(Default)]
pub struct Downloads {
    test_dir: Option<PathBuf>,
    next_id: AtomicU64,
    active: Mutex<HashMap<String, Writer>>,
    saved: Mutex<VecDeque<(String, PathBuf)>>,
}

impl Downloads {
    /// `test_dir`: the test hook's directory (no dialog).
    pub fn new(test_dir: Option<PathBuf>) -> Self {
        Self { test_dir, ..Self::default() }
    }

    pub fn from_env() -> Self {
        Self::new(std::env::var_os(TEST_SAVE_DIR_ENV).filter(|d| !d.is_empty()).map(PathBuf::from))
    }

    pub fn test_dir(&self) -> Option<&Path> {
        self.test_dir.as_deref()
    }

    /// A fresh id for a save.
    pub fn next_id(&self) -> String {
        (self.next_id.fetch_add(1, Ordering::Relaxed) + 1).to_string()
    }

    /// Registers a running save under `id`.
    pub fn begin(&self, id: &str, writer: ChunkWriter) -> Result<(), DownloadError> {
        let mut active = self.active.lock().map_err(|_| DownloadError::WriteFailed)?;
        if active.contains_key(id) {
            return Err(DownloadError::Duplicate);
        }
        if active.len() >= MAX_ACTIVE {
            return Err(DownloadError::Busy);
        }
        active.insert(id.to_string(), Arc::new(Mutex::new(writer)));
        Ok(())
    }

    /// The running save `id`.
    fn writer(&self, id: &str) -> Result<Writer, DownloadError> {
        self.active.lock().map_err(|_| DownloadError::WriteFailed)?.get(id).cloned().ok_or(DownloadError::Unknown)
    }

    /// Room for one more save (checked before the dialog opens).
    pub fn has_room(&self) -> bool {
        self.active.lock().is_ok_and(|a| a.len() < MAX_ACTIVE)
    }

    /// Appends to the save `id` (blocking I/O: the command runs it on the blocking pool).
    pub fn chunk(&self, id: &str, bytes: &[u8]) -> Result<(), DownloadError> {
        let writer = self.writer(id)?;
        let mut w = writer.lock().map_err(|_| DownloadError::WriteFailed)?;
        w.write(bytes)
    }

    /// Finishes the save (also when that fails, the save is over and its temporary file removed). Blocking I/O
    /// (`fsync`, rename): the command runs it on the blocking pool.
    pub fn end(&self, id: &str) -> Result<PathBuf, DownloadError> {
        let writer = self.active.lock().map_err(|_| DownloadError::WriteFailed)?.remove(id).ok_or(DownloadError::Unknown)?;
        let path = writer.lock().map_err(|_| DownloadError::WriteFailed)?.finish_in_place()?;
        if let Ok(mut saved) = self.saved.lock() {
            if saved.len() >= MAX_SAVED {
                saved.pop_front();
            }
            saved.push_back((id.to_string(), path.clone()));
        }
        Ok(path)
    }

    /// Ends the save `id` without a file (the temporary file goes once no chunk of it is being written any more).
    pub fn abort(&self, id: &str) {
        drop(self.active.lock().ok().and_then(|mut a| a.remove(id)));
    }

    /// The file a finished save wrote.
    pub fn saved_path(&self, id: &str) -> Option<PathBuf> {
        self.saved.lock().ok()?.iter().rev().find(|(i, _)| i == id).map(|(_, p)| p.clone())
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Begin {
    Ready { id: String },
    Cancelled,
}

#[derive(Debug, Serialize)]
pub struct Saved {
    pub path: String,
    /// The name of the directory ("Downloads"), for "Saved to …".
    pub folder: String,
}

fn saved(path: &Path) -> Saved {
    let folder = path.parent().map(|d| d.file_name().map_or_else(|| d.to_string_lossy(), |n| n.to_string_lossy()).into_owned()).unwrap_or_default();
    Saved { path: path.to_string_lossy().into_owned(), folder }
}

/// Asks the user where `name` goes (the test hook: its directory, never overwriting); None when cancelled.
async fn choose_target<R: Runtime>(app: &AppHandle<R>, downloads: &Downloads, name: &str) -> Result<Option<PathBuf>, DownloadError> {
    if let Some(dir) = downloads.test_dir() {
        return Ok(Some(unique_target(dir, name)));
    }
    let mut dialog = app.dialog().file().set_file_name(name);
    if let Some(ext) = extension(name) {
        dialog = dialog.add_filter(ext.to_ascii_uppercase(), &[ext.as_str()]);
    }
    if let Some(window) = app.get_webview_window(crate::MAIN_WINDOW) {
        dialog = dialog.set_parent(&window);
    }
    let chosen = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file()).await.map_err(|_| DownloadError::Dialog)?;
    chosen.map(|p| p.into_path().map_err(|_| DownloadError::Dialog)).transpose()
}

/// Shows the save dialog for a file of `size` bytes; the client streams it with `save_file_chunk` afterwards.
#[tauri::command]
pub async fn save_file_begin<R: Runtime>(app: AppHandle<R>, downloads: State<'_, Downloads>, name: String, size: u64) -> Result<Begin, String> {
    if !downloads.has_room() {
        return Err(DownloadError::Busy.into());
    }
    let name = safe_file_name(&name);
    let Some(target) = choose_target(&app, &downloads, &name).await? else {
        return Ok(Begin::Cancelled);
    };
    let writer = ChunkWriter::begin(target, size).map_err(|e| write_failed("create", &e))?;
    let id = downloads.next_id();
    downloads.begin(&id, writer)?;
    Ok(Begin::Ready { id })
}

/// Runs blocking file I/O of the saves on the blocking pool: neither the main thread nor the async workers (which also
/// run the native voice engine's audio tasks) wait for a disk.
async fn blocking<R: Runtime, T: Send + 'static>(
    app: &AppHandle<R>,
    f: impl FnOnce(&Downloads) -> Result<T, DownloadError> + Send + 'static,
) -> Result<T, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || f(&app.state::<Downloads>())).await.map_err(|_| String::from(DownloadError::WriteFailed))?.map_err(Into::into)
}

/// Appends the raw body to the save named by the `x-tavrn-save` header (on the blocking pool, `blocking`).
#[tauri::command]
pub async fn save_file_chunk<R: Runtime>(app: AppHandle<R>, request: Request<'_>) -> Result<(), String> {
    let id = request.headers().get(SAVE_HEADER).and_then(|v| v.to_str().ok()).ok_or(DownloadError::InvalidBody)?.to_string();
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(DownloadError::InvalidBody.into());
    };
    // The body is borrowed from the request; the blocking task needs its own copy (one memcpy per chunk).
    let bytes = bytes.clone();
    blocking(&app, move |d| d.chunk(&id, &bytes)).await
}

#[tauri::command]
pub async fn save_file_end<R: Runtime>(app: AppHandle<R>, id: String) -> Result<Saved, String> {
    blocking(&app, move |d| d.end(&id).map(|p| saved(&p))).await
}

#[tauri::command]
pub async fn save_file_abort(downloads: State<'_, Downloads>, id: String) -> Result<(), String> {
    downloads.abort(&id);
    Ok(())
}

/// Shows a finished save in the file manager.
#[tauri::command]
pub async fn save_file_reveal(downloads: State<'_, Downloads>, id: String) -> Result<(), String> {
    let path = downloads.saved_path(&id).ok_or(DownloadError::Unknown)?;
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(|_| "download.reveal_failed".to_string())
}

/// Where the safety net lets the webview write: a fresh file in the app's cache (`downloads/`).
fn staging_path<R: Runtime>(app: &AppHandle<R>, suggested: &Path) -> Option<PathBuf> {
    let dir = app.path().app_cache_dir().ok()?.join("downloads");
    fs::create_dir_all(&dir).ok()?;
    let name = safe_file_name(suggested.file_name().and_then(|n| n.to_str()).unwrap_or_default());
    Some(unique_target(&dir, &name))
}

/// Moves a finished file to `target`: a rename, or a copy into a temporary file next to it and a rename when the
/// directories are on different file systems.
pub fn move_into_place(from: &Path, target: &Path) -> io::Result<()> {
    if fs::rename(from, target).is_ok() {
        return Ok(());
    }
    let size = fs::metadata(from)?.len();
    let mut writer = ChunkWriter::begin(target.to_path_buf(), size)?;
    io::copy(&mut File::open(from)?, writer.file.as_mut().ok_or_else(|| io::Error::other("closed"))?)?;
    writer.written = size;
    writer.finish().map_err(|e| io::Error::other(e.code()))?;
    fs::remove_file(from)
}

/// The safety net for downloads the webview starts itself: they land in the app's cache, then the save dialog asks
/// where the file goes (cancelled: the file is removed). Wired with `WebviewWindowBuilder::on_download` (lib.rs).
pub fn webview_download<R: Runtime>(webview: Webview<R>, event: DownloadEvent<'_>) -> bool {
    let app = webview.app_handle().clone();
    match event {
        DownloadEvent::Requested { url, destination } => {
            if !allowed_download_url(&url) {
                return false;
            }
            match staging_path(&app, destination) {
                Some(staged) => {
                    *destination = staged;
                    true
                }
                None => false,
            }
        }
        DownloadEvent::Finished { path, success, .. } => {
            let Some(staged) = path else { return true };
            if !success {
                let _ = fs::remove_file(&staged);
                return true;
            }
            tauri::async_runtime::spawn(async move {
                let Some(downloads) = app.try_state::<Downloads>() else { return };
                let name = safe_file_name(staged.file_name().and_then(|n| n.to_str()).unwrap_or_default());
                match choose_target(&app, &downloads, &name).await {
                    Ok(Some(target)) => {
                        if let Err(e) = move_into_place(&staged, &target) {
                            eprintln!("tavrn: a download could not be saved: {e}");
                            let _ = fs::remove_file(&staged);
                        }
                    }
                    _ => {
                        let _ = fs::remove_file(&staged);
                    }
                }
            });
            true
        }
        _ => false,
    }
}

/// Downloads the webview may start: the client's own blob and data URLs and files of the bundle or the web.
fn allowed_download_url(url: &Url) -> bool {
    matches!(url.scheme(), "blob" | "data" | "https" | "http" | "tauri")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> PathBuf {
        let n = TEST_DIRS.fetch_add(1, Ordering::Relaxed);
        let d = std::env::temp_dir().join(format!("tavrn-download-test-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap_or_else(|e| unreachable!("temp dir: {e}"));
        d
    }
    static TEST_DIRS: AtomicU64 = AtomicU64::new(0);

    fn entries(d: &Path) -> Vec<String> {
        let mut names: Vec<String> =
            fs::read_dir(d).map(|r| r.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
        names.sort();
        names
    }

    fn ok<T, E: std::fmt::Debug>(r: Result<T, E>) -> T {
        r.unwrap_or_else(|e| unreachable!("{e:?}"))
    }

    #[test]
    fn writes_into_a_temporary_file_and_renames_it_into_place() {
        let d = dir();
        let target = d.join("plan.pdf");
        let mut w = ok(ChunkWriter::begin(target.clone(), 6));
        let temp = w.temp_path().to_path_buf();
        assert_eq!(temp.parent(), Some(d.as_path()), "the temporary file sits next to the target");
        assert!(temp.exists() && !target.exists());
        ok(w.write(b"abc"));
        ok(w.write(b"def"));
        assert_eq!(ok(w.finish()), target);
        assert_eq!(ok(fs::read(&target)), b"abcdef");
        assert_eq!(entries(&d), ["plan.pdf"], "no temporary file is left");
    }

    #[test]
    fn refuses_more_bytes_than_announced_and_too_few() {
        let d = dir();
        let mut w = ok(ChunkWriter::begin(d.join("a.txt"), 3));
        ok(w.write(b"ab"));
        assert_eq!(w.write(b"cd"), Err(DownloadError::TooLarge));
        assert_eq!(w.finish(), Err(DownloadError::Incomplete));
        assert!(entries(&d).is_empty(), "a refused save leaves nothing behind");
    }

    #[test]
    fn an_empty_file_is_saved() {
        let d = dir();
        let w = ok(ChunkWriter::begin(d.join("empty.txt"), 0));
        ok(w.finish());
        assert_eq!(ok(fs::read(d.join("empty.txt"))), b"");
    }

    #[test]
    fn abort_and_drop_remove_the_temporary_file() {
        let d = dir();
        let mut w = ok(ChunkWriter::begin(d.join("a.txt"), 10));
        ok(w.write(b"half"));
        w.abort();
        let w2 = ok(ChunkWriter::begin(d.join("b.txt"), 10));
        drop(w2);
        assert!(entries(&d).is_empty());
    }

    #[test]
    fn an_existing_target_is_replaced_only_on_finish() {
        let d = dir();
        let target = d.join("a.txt");
        ok(fs::write(&target, b"old"));
        let mut w = ok(ChunkWriter::begin(target.clone(), 3));
        ok(w.write(b"new"));
        assert_eq!(ok(fs::read(&target)), b"old");
        ok(w.finish());
        assert_eq!(ok(fs::read(&target)), b"new");
    }

    #[test]
    fn the_registry_refuses_a_second_begin_with_the_same_id_and_unknown_ids() {
        let d = dir();
        let downloads = Downloads::new(None);
        ok(downloads.begin("1", ok(ChunkWriter::begin(d.join("a.txt"), 1))));
        assert_eq!(downloads.begin("1", ok(ChunkWriter::begin(d.join("b.txt"), 1))), Err(DownloadError::Duplicate));
        assert_eq!(downloads.chunk("2", b"x"), Err(DownloadError::Unknown));
        assert_eq!(downloads.end("2"), Err(DownloadError::Unknown));
        ok(downloads.chunk("1", b"x"));
        let path = ok(downloads.end("1"));
        assert_eq!(path, d.join("a.txt"));
        assert_eq!(downloads.saved_path("1"), Some(path));
        assert_eq!(downloads.end("1"), Err(DownloadError::Unknown), "a finished save is over");
        assert_eq!(entries(&d), ["a.txt"], "the refused writer removed its temporary file");
    }

    #[test]
    fn the_registry_limits_running_saves_and_aborts() {
        let d = dir();
        let downloads = Downloads::new(None);
        for n in 0..MAX_ACTIVE {
            ok(downloads.begin(&n.to_string(), ok(ChunkWriter::begin(d.join(format!("{n}.bin")), 1))));
        }
        assert!(!downloads.has_room());
        assert_eq!(downloads.begin("x", ok(ChunkWriter::begin(d.join("x.bin"), 1))), Err(DownloadError::Busy));
        for n in 0..MAX_ACTIVE {
            downloads.abort(&n.to_string());
        }
        assert!(downloads.has_room());
        assert!(entries(&d).is_empty());
        assert_eq!(downloads.saved_path("0"), None);
    }

    #[test]
    fn a_save_being_written_does_not_hold_the_others() {
        let d = dir();
        let downloads = Arc::new(Downloads::new(None));
        ok(downloads.begin("1", ok(ChunkWriter::begin(d.join("slow.bin"), 1))));
        ok(downloads.begin("2", ok(ChunkWriter::begin(d.join("fast.bin"), 1))));
        // Save 1 is busy (a slow disk, a long flush): its own lock is held.
        let slow = ok(downloads.writer("1"));
        let busy = ok(slow.lock());
        let (tx, rx) = std::sync::mpsc::channel();
        let other = Arc::clone(&downloads);
        std::thread::spawn(move || {
            let r = other.chunk("2", b"x").and_then(|()| other.end("2"));
            let _ = tx.send(r);
        });
        let done = rx.recv_timeout(std::time::Duration::from_secs(5));
        assert!(matches!(done, Ok(Ok(_))), "save 2 finished while save 1 was busy: {done:?}");
        drop(busy);
        ok(downloads.chunk("1", b"y"));
        ok(downloads.end("1"));
        assert_eq!(entries(&d), ["fast.bin", "slow.bin"]);
    }

    #[test]
    fn ids_are_fresh() {
        let downloads = Downloads::new(None);
        assert_ne!(downloads.next_id(), downloads.next_id());
    }

    #[test]
    fn names_from_the_webview_cannot_leave_the_directory() {
        assert_eq!(safe_file_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_file_name("..\\..\\Windows\\win.ini"), "win.ini");
        assert_eq!(safe_file_name("/abs/path/report.pdf"), "report.pdf");
        assert_eq!(safe_file_name(".."), "download");
        assert_eq!(safe_file_name(".bashrc"), "bashrc");
        assert_eq!(safe_file_name(""), "download");
        assert_eq!(safe_file_name("a<b>c:d\"e|f?g*h\u{0}i.txt"), "a_b_c_d_e_f_g_h_i.txt");
        assert_eq!(safe_file_name("notes. . "), "notes");
        assert_eq!(safe_file_name("CON.txt"), "_CON.txt");
        assert_eq!(safe_file_name("lpt1"), "_lpt1");
        assert_eq!(safe_file_name("console.txt"), "console.txt");
        assert_eq!(safe_file_name("Geheimplan ü.txt"), "Geheimplan ü.txt");
        let long = format!("{}.pdf", "ä".repeat(300));
        let cut = safe_file_name(&long);
        assert!(cut.len() <= MAX_NAME_BYTES && cut.ends_with(".pdf"), "{cut}");
    }

    #[test]
    fn the_filter_comes_from_the_extension() {
        assert_eq!(extension("plan.PDF").as_deref(), Some("pdf"));
        assert_eq!(extension("archive.tar.gz").as_deref(), Some("gz"));
        assert_eq!(extension("README"), None);
        assert_eq!(extension("bashrc."), None);
        assert_eq!(extension("x.this-is-no-ext"), None);
    }

    #[test]
    fn the_test_hook_and_the_safety_net_never_overwrite() {
        let d = dir();
        assert_eq!(unique_target(&d, "a.txt"), d.join("a.txt"));
        ok(fs::write(d.join("a.txt"), b"1"));
        ok(fs::write(d.join("a (1).txt"), b"2"));
        assert_eq!(unique_target(&d, "a.txt"), d.join("a (2).txt"));
        ok(fs::write(d.join("README"), b"3"));
        assert_eq!(unique_target(&d, "README"), d.join("README (1)"));
    }

    #[test]
    fn a_staged_file_moves_into_place() {
        let d = dir();
        let from = d.join("staged.bin");
        ok(fs::write(&from, b"content"));
        let sub = d.join("chosen");
        ok(fs::create_dir_all(&sub));
        ok(move_into_place(&from, &sub.join("final.bin")));
        assert_eq!(ok(fs::read(sub.join("final.bin"))), b"content");
        assert!(!from.exists());
    }

    #[test]
    fn the_test_directory_comes_only_from_the_environment_variable() {
        assert_eq!(Downloads::new(None).test_dir(), None);
        assert_eq!(Downloads::new(Some(PathBuf::from("/tmp/x"))).test_dir(), Some(Path::new("/tmp/x")));
    }

    #[test]
    fn begin_answers_carry_a_status() {
        assert_eq!(ok(serde_json::to_value(Begin::Ready { id: "3".into() })), serde_json::json!({ "status": "ready", "id": "3" }));
        assert_eq!(ok(serde_json::to_value(Begin::Cancelled)), serde_json::json!({ "status": "cancelled" }));
        let s = saved(Path::new("/home/alice/Downloads/plan.pdf"));
        assert_eq!((s.path.as_str(), s.folder.as_str()), ("/home/alice/Downloads/plan.pdf", "Downloads"));
    }
}
