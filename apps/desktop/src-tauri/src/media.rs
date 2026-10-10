// SPDX-License-Identifier: Apache-2.0
//! Voice and video in the webview (docs/DESKTOP.md "Voice": the webview's own WebRTC on Linux). The window shows only the bundled client
//! (`guard.rs`), so its requests for the microphone and the camera are granted without a prompt of the webview;
//! screen capture and everything else keep the webview's default. On Linux WebKitGTK keeps WebRTC and media streams
//! off unless the app switches them on; the media itself runs through the system's GStreamer plugins (Linux builds are for
//! development and tests only: Linux ships the Electron shell).

use tauri::webview::{PermissionKind, PermissionResponse};

/// The answer to a permission request of the bundled client.
pub fn permission(kind: PermissionKind) -> PermissionResponse {
    match kind {
        PermissionKind::Microphone | PermissionKind::Camera => PermissionResponse::Allow,
        _ => PermissionResponse::Default,
    }
}

/// Switches on WebRTC (`RTCPeerConnection`) and media streams (`getUserMedia`) of the WebKitGTK webview.
#[cfg(target_os = "linux")]
pub fn enable_webrtc<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> tauri::Result<()> {
    window.with_webview(|webview| {
        use webkit2gtk::{SettingsExt, WebViewExt};
        if let Some(settings) = webview.inner().settings() {
            settings.set_enable_webrtc(true);
            settings.set_enable_media_stream(true);
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grants_microphone_and_camera_only() {
        assert!(matches!(permission(PermissionKind::Microphone), PermissionResponse::Allow));
        assert!(matches!(permission(PermissionKind::Camera), PermissionResponse::Allow));
        for other in [PermissionKind::DisplayCapture, PermissionKind::Geolocation, PermissionKind::Notifications, PermissionKind::Other] {
            assert!(matches!(permission(other), PermissionResponse::Default));
        }
    }
}
