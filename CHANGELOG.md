# Changelog

Changes of the web client and the desktop apps, newest first. Releases are the tags `vX.Y.Z` of this repository: the
release carries the web bundle (`tavrn-web-X.Y.Z.tar.gz` with its SHA-256) and the desktop installers with their
checksums and update files. The node's container image embeds the web client of a release.

## Unreleased

First public release of the web client and the desktop apps.

- **Web client**: rooms with text, voice, announcement, forum and files channels, threads, direct messages and
  friends across nodes, voice, video, screen sharing, the soundboard and background effects, the whiteboard, roles
  and layered permissions with editors, moderation and the admin pages; end-to-end encryption everywhere a
  conversation is encrypted, with history for new members and history restore after a key reset; phones, tablets
  and desktops; English and German; WCAG 2.2 AA as the accessibility target.
- **Desktop app for Windows** (Tauri): `.msi` and NSIS installer, signed self-updates, sign-in through the node's own
  page with passkey unlock, the OS keychain, global hotkeys (push-to-talk, priority speaker, mute, deafen), tray,
  native notifications and downloads.
- **Desktop app for Linux** (Electron): `.AppImage` and `.deb` with the same client in Chromium (voice, video and
  screen sharing as in the browser), the desktop's keyring, tray, notifications, global hotkeys and its own updater.

### Security

- Release builds no longer see the updater signing key: a separate job in a protected `release` environment signs the
  finished installers and feeds, installs only the signer without lifecycle scripts and verifies every signature.
- The Linux packages of a release are hashed and uploaded before the end-to-end specs download and run anything; the
  specs test a copy and use a node image pinned by digest.
- CI installs `just` and `livekit-server` only from downloads with pinned checksums.
- Release assets carry GitHub build provenance attestations; the docs explain how to verify a first install against
  the signed feed.
- Self-hosted CI runners refuse `dependabot/*` branches even when a run is dispatched by hand.
- `cargo deny` checks advisories, bans and sources (not only licenses) for both desktop shells.
- The publication check prints only file and line of a private match, never the matching text.
