// SPDX-License-Identifier: Apache-2.0
//! The key listener on Windows: a low-level keyboard hook (`WH_KEYBOARD_LL`) on a thread of its own with a message
//! loop. The hook procedure only looks at the key and always passes it on (`CallNextHookEx`), so the program with the
//! focus gets every key; it maps the scan code to the physical key, drops every key outside the filter at once and
//! hands the rest to a channel (Windows removes a hook that answers too slowly, so nothing else happens there).
//!
//! A release the hook never sees (the secure desktop of Ctrl+Alt+Del, a window of an elevated program with the focus)
//! would leave a key held, and push-to-talk open. While keys are held a timer checks every 500 ms whether they are
//! still down (`GetAsyncKeyState`) and reports a release for a key found up twice in a row.

use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, MAPVK_VK_TO_VSC_EX, MapVirtualKeyW};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, HC_ACTION, KBDLLHOOKSTRUCT, KillTimer, LLKHF_EXTENDED, MSG, PostThreadMessageW, SetTimer, SetWindowsHookExW,
    UnhookWindowsHookEx, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP, WM_TIMER,
};

use super::{Key, KeyFilter, RawKey, Unavailable, Watcher};

/// A held key: its virtual-key code (for `GetAsyncKeyState`) and how many timer checks found it up.
struct Held {
    key: Key,
    vk: u32,
    up: u8,
}

/// What the hook procedure needs (it is a plain function: the state is global, one hook at a time).
struct Hook {
    filter: Arc<KeyFilter>,
    sink: Sender<RawKey>,
    held: Vec<Held>,
}

static HOOK: Mutex<Option<Hook>> = Mutex::new(None);

struct LowLevelHook {
    thread_id: u32,
    thread: Option<JoinHandle<()>>,
}

impl Watcher for LowLevelHook {}

impl Drop for LowLevelHook {
    fn drop(&mut self) {
        // SAFETY: posting a message to a thread id has no memory effects; WM_QUIT ends its message loop.
        unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, 0, 0) };
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        if let Ok(mut hook) = HOOK.lock() {
            *hook = None;
        }
    }
}

/// The scan code of a hook event (`0xE0..` for extended keys); injected events may carry only the virtual key.
fn scan_code(kb: &KBDLLHOOKSTRUCT) -> u16 {
    if kb.scanCode == 0 {
        // SAFETY: a pure lookup in the keyboard layout.
        return unsafe { MapVirtualKeyW(kb.vkCode, MAPVK_VK_TO_VSC_EX) } as u16;
    }
    let extended = if kb.flags & LLKHF_EXTENDED != 0 { 0xe000 } else { 0 };
    (kb.scanCode as u16 & 0xfff) | extended
}

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 && lparam != 0 {
        // SAFETY: for HC_ACTION, lparam points to the KBDLLHOOKSTRUCT of this event.
        let kb = unsafe { &*(lparam as *const KBDLLHOOKSTRUCT) };
        let pressed = match wparam as u32 {
            WM_KEYDOWN | WM_SYSKEYDOWN => Some(true),
            WM_KEYUP | WM_SYSKEYUP => Some(false),
            _ => None,
        };
        if let (Some(pressed), Some(key)) = (pressed, Key::from_scan_code(scan_code(kb)))
            && let Ok(mut guard) = HOOK.lock()
            && let Some(hook) = guard.as_mut()
            && hook.filter.contains(key)
        {
            hook.held.retain(|h| h.key != key);
            if pressed {
                hook.held.push(Held { key, vk: kb.vkCode, up: 0 });
            }
            let _ = hook.sink.send(RawKey { key, pressed });
        }
    }
    // SAFETY: always passing the event on: the listener observes, it never swallows a key.
    unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) }
}

/// The timer's check: a held key that is up in two checks in a row gets its release.
fn check_held() {
    let Ok(mut guard) = HOOK.lock() else { return };
    let Some(hook) = guard.as_mut() else { return };
    let mut released = Vec::new();
    for h in &mut hook.held {
        // SAFETY: reads the asynchronous key state, no memory effects.
        let down = unsafe { GetAsyncKeyState(h.vk as i32) } as u16 & 0x8000 != 0;
        h.up = if down { 0 } else { h.up + 1 };
        if h.up >= 2 {
            released.push(h.key);
        }
    }
    hook.held.retain(|h| h.up < 2);
    for key in released {
        let _ = hook.sink.send(RawKey { key, pressed: false });
    }
}

pub fn start(filter: Arc<KeyFilter>, sink: Sender<RawKey>) -> Result<Box<dyn Watcher>, Unavailable> {
    {
        let mut hook = HOOK.lock().map_err(|_| Unavailable("hook state poisoned".into()))?;
        if hook.is_some() {
            return Err(Unavailable("a keyboard hook is already installed".into()));
        }
        *hook = Some(Hook { filter, sink, held: Vec::new() });
    }
    let (ready_tx, ready) = mpsc::channel::<Result<u32, String>>();
    let thread = std::thread::Builder::new()
        .name("tavrn-keywatch".into())
        .spawn(move || {
            // SAFETY: the hook procedure is a plain function of this module; the hook is removed before the thread ends.
            let hook = unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), GetModuleHandleW(std::ptr::null()), 0) };
            if hook.is_null() {
                let _ = ready_tx.send(Err(format!("SetWindowsHookExW failed: {}", std::io::Error::last_os_error())));
                return;
            }
            // SAFETY: GetCurrentThreadId has no preconditions.
            let _ = ready_tx.send(Ok(unsafe { GetCurrentThreadId() }));
            // SAFETY: a thread timer without a window; its WM_TIMER arrives in this loop.
            let timer = unsafe { SetTimer(std::ptr::null_mut(), 0, 500, None) };
            // SAFETY: MSG is plain data; GetMessageW fills it. The loop ends with WM_QUIT (0) or an error (-1).
            let mut msg: MSG = unsafe { std::mem::zeroed() };
            while unsafe { GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) } > 0 {
                if msg.message == WM_TIMER {
                    check_held();
                }
            }
            // SAFETY: the timer and the hook were created on this thread above.
            unsafe {
                KillTimer(std::ptr::null_mut(), timer);
                UnhookWindowsHookEx(hook);
            }
        })
        .map_err(|e| Unavailable(format!("no thread: {e}")))?;
    match ready.recv() {
        Ok(Ok(thread_id)) => Ok(Box::new(LowLevelHook { thread_id, thread: Some(thread) })),
        Ok(Err(e)) => {
            let _ = thread.join();
            if let Ok(mut hook) = HOOK.lock() {
                *hook = None;
            }
            Err(Unavailable(e))
        }
        Err(_) => {
            if let Ok(mut hook) = HOOK.lock() {
                *hook = None;
            }
            Err(Unavailable("the hook thread ended".into()))
        }
    }
}
