// SPDX-License-Identifier: Apache-2.0
//! Whether a FIDO security key is plugged in, without touching it: the HID report descriptors in sysfs
//! (`/sys/class/hidraw/*/device/report_descriptor`, readable by everyone) name the FIDO Alliance's usage page 0xF1D0
//! with the CTAPHID usage 0x01 (CTAP 2.1 §11.2.8.1). Whether the app may open the key is a second question: the device
//! node `/dev/hidrawN` belongs to root unless udev grants the seat's user access (systemd's `60-fido-id.rules` and
//! `70-uaccess.rules` do on current distributions; docs/DESKTOP.md "Passkeys on Linux").

use std::fs::{self, OpenOptions};
use std::path::Path;

/// The FIDO security keys of this computer.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Keys {
    /// Keys plugged in.
    pub present: usize,
    /// Of those, the ones this user may open (read and write).
    pub usable: usize,
}

/// Whether a HID report descriptor describes a FIDO (CTAPHID) interface: usage page 0xF1D0, usage 0x01. Short items
/// only (long items are skipped by their size); a usage page item may be 1, 2 or 4 bytes long.
pub fn is_fido_descriptor(descriptor: &[u8]) -> bool {
    let mut page: u32 = 0;
    let mut i = 0;
    while i < descriptor.len() {
        let prefix = descriptor[i];
        // A long item: 0xFE, its data size, its tag, then the data.
        if prefix == 0xFE {
            let size = descriptor.get(i + 1).copied().unwrap_or(0) as usize;
            i += 3 + size;
            continue;
        }
        let size = match prefix & 0x03 {
            3 => 4,
            n => n as usize,
        };
        let Some(data) = descriptor.get(i + 1..i + 1 + size) else { return false };
        let value = data.iter().rev().fold(0u32, |v, b| (v << 8) | u32::from(*b));
        match prefix & 0xFC {
            // Usage Page (global item).
            0x04 => page = value,
            // Usage (local item): a 4-byte usage carries its page in the upper half.
            0x08 => {
                let (usage_page, usage) = if size == 4 { (value >> 16, value & 0xFFFF) } else { (page, value) };
                if usage_page == 0xF1D0 && usage == 0x01 {
                    return true;
                }
            }
            _ => {}
        }
        i += 1 + size;
    }
    false
}

/// The FIDO keys under a sysfs class directory (`/sys/class/hidraw`) with their device nodes under `dev`.
pub fn scan(class: &Path, dev: &Path) -> Keys {
    let Ok(entries) = fs::read_dir(class) else { return Keys::default() };
    let mut keys = Keys::default();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str().filter(|n| n.starts_with("hidraw") && n[6..].chars().all(|c| c.is_ascii_digit())) else { continue };
        let Ok(descriptor) = fs::read(entry.path().join("device/report_descriptor")) else { continue };
        if !is_fido_descriptor(&descriptor) {
            continue;
        }
        keys.present += 1;
        // Opening a hidraw node sends nothing to the key.
        if OpenOptions::new().read(true).write(true).open(dev.join(name)).is_ok() {
            keys.usable += 1;
        }
    }
    keys
}

/// The FIDO keys plugged into this computer (none on systems without hidraw).
pub fn keys() -> Keys {
    scan(Path::new("/sys/class/hidraw"), Path::new("/dev"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The report descriptor of a typical FIDO key (usage page 0xF1D0, usage CTAPHID, 64-byte reports).
    const FIDO: &[u8] = &[
        0x06, 0xD0, 0xF1, 0x09, 0x01, 0xA1, 0x01, 0x09, 0x20, 0x15, 0x00, 0x26, 0xFF, 0x00, 0x75, 0x08, 0x95, 0x40, 0x81, 0x02, 0x09, 0x21, 0x15, 0x00, 0x26,
        0xFF, 0x00, 0x75, 0x08, 0x95, 0x40, 0x91, 0x02, 0xC0,
    ];
    /// A keyboard (generic desktop page, usage 0x06).
    const KEYBOARD: &[u8] =
        &[0x05, 0x01, 0x09, 0x06, 0xA1, 0x01, 0x05, 0x07, 0x19, 0xE0, 0x29, 0xE7, 0x15, 0x00, 0x25, 0x01, 0x75, 0x01, 0x95, 0x08, 0x81, 0x02, 0xC0];

    #[test]
    fn fido_interfaces_are_told_apart() {
        assert!(is_fido_descriptor(FIDO));
        assert!(!is_fido_descriptor(KEYBOARD));
        // A 4-byte usage with its page; a long item before it; the usage page of another report.
        assert!(is_fido_descriptor(&[0x0B, 0x01, 0x00, 0xD0, 0xF1, 0xA1, 0x01, 0xC0]));
        assert!(is_fido_descriptor(&[0xFE, 0x02, 0x10, 0xAA, 0xBB, 0x06, 0xD0, 0xF1, 0x09, 0x01]));
        assert!(!is_fido_descriptor(&[0x06, 0xD0, 0xF1, 0x09, 0x02]), "another usage of the page");
        assert!(!is_fido_descriptor(&[0x06, 0xD0]), "truncated");
        assert!(!is_fido_descriptor(&[]));
    }

    #[test]
    fn the_keys_of_a_sysfs_tree() {
        let root = std::env::temp_dir().join(format!("tavrn-fido-devices-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let (class, dev) = (root.join("class"), root.join("dev"));
        for (name, descriptor, node) in [("hidraw0", KEYBOARD, true), ("hidraw1", FIDO, true), ("hidraw2", FIDO, false), ("hidrawx", FIDO, true)] {
            let dir = class.join(name).join("device");
            fs::create_dir_all(&dir).unwrap_or_else(|e| unreachable!("{e}"));
            fs::write(dir.join("report_descriptor"), descriptor).unwrap_or_else(|e| unreachable!("{e}"));
            fs::create_dir_all(&dev).unwrap_or_else(|e| unreachable!("{e}"));
            if node {
                fs::write(dev.join(name), b"").unwrap_or_else(|e| unreachable!("{e}"));
            }
        }
        // hidraw1 can be opened, hidraw2 has no node this user may open, hidrawx is not a hidraw name.
        assert_eq!(scan(&class, &dev), Keys { present: 2, usable: 1 });
        assert_eq!(scan(&root.join("missing"), &dev), Keys::default());
        let _ = fs::remove_dir_all(&root);
    }
}
