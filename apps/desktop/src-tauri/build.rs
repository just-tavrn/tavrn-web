// SPDX-License-Identifier: Apache-2.0
// The app's commands get permissions of their own (capabilities/main.json grants the desktop's to the main window,
// capabilities/mobile.json the Android app's: docs/ANDROID.md).
fn main() {
    let commands = &[
        "get_config",
        "set_node",
        "app_info",
        "open_external",
        "check_update",
        "install_update",
        "get_update_channel",
        "set_update_channel",
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
        // Downloads (src/download.rs).
        "save_file_begin",
        "save_file_chunk",
        "save_file_end",
        "save_file_abort",
        "save_file_reveal",
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
        // Passkeys through the Windows WebAuthn API (src/passkey.rs).
        "passkey_create",
        "passkey_get",
        // Game activity (src/games.rs).
        "games_watch",
        // The Android app (src/android.rs).
        "android_info",
        "android_permission",
        "android_open_settings",
        "android_battery_exemption",
        "android_voice",
        "android_background",
        "android_push_register",
        "android_push_unregister",
        "android_push_config",
        "android_keep_connection",
        "android_check_update",
        "android_save_begin",
        "android_save_chunk",
        "android_save_end",
        "android_save_abort",
        "android_audio_routes",
        "android_audio_route",
        "android_orientation",
        // Unlock with fingerprint, face or PIN (src/android.rs → BiometricUnlock.kt).
        "android_unlock_status",
        "android_unlock_store",
        "android_unlock_get",
        "android_unlock_clear",
        // Screen sharing (src/android.rs → ScreenShare.kt, VOICE.md §4b).
        "android_screen_share_start",
        "android_screen_share_key",
        "android_screen_share_stop",
        "android_screen_share_status",
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
