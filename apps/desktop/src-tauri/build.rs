// SPDX-License-Identifier: Apache-2.0
// The app's commands get permissions of their own (capabilities/main.json grants them to the main window only).
fn main() {
    let commands = &["get_config", "set_node", "app_info", "open_external", "check_update", "install_update", "resolve_node", "open_connect", "close_connect", "register_hotkey", "unregister_hotkey", "listen_hotkeys"];
    let attributes = tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(commands));
    if let Err(e) = tauri_build::try_build(attributes) {
        eprintln!("tauri-build failed: {e:#}");
        std::process::exit(1);
    }
}
