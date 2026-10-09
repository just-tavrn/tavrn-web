// SPDX-License-Identifier: Apache-2.0
// The app's commands get permissions of their own (capabilities/main.json grants them to the main window only).
fn main() {
    let commands = &[
        "get_config",
        "set_node",
        "app_info",
        "open_external",
        "check_update",
        "install_update",
        "resolve_node",
        "open_connect",
        "close_connect",
        "keychain_get",
        "keychain_set",
        "keychain_delete",
        "keychain_status",
        "notify",
        "shell_events",
        "tray_set",
        "tray_status",
        "set_close_to_tray",
        "quit_app",
        "register_hotkey",
        "unregister_hotkey",
        "listen_hotkeys",
        "set_hotkeys_enabled",
        "voice_info",
        "voice_devices",
        "voice_join",
        "voice_leave",
        "voice_set_key",
        "voice_set_muted",
        "voice_set_deafened",
        "voice_set_ptt",
        "voice_configure",
        "voice_set_volumes",
    ];
    // Windows: the whole C runtime is linked statically (+crt-static in .cargo/config.toml, for the prebuilt libwebrtc
    // of the native voice engine), so Tauri's own hybrid runtime (static vcruntime, dynamic ucrt) must stay out.
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(commands))
        .windows_attributes(tauri_build::WindowsAttributes::new().static_vc_runtime(false));
    if let Err(e) = tauri_build::try_build(attributes) {
        eprintln!("tauri-build failed: {e:#}");
        std::process::exit(1);
    }
}
