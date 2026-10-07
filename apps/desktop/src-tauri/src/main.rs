// SPDX-License-Identifier: Apache-2.0
// No console window next to the app on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tavrn_desktop_lib::run();
}
