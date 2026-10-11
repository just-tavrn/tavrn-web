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

- Plaintext in end-to-end encrypted conversations is shown as "not end-to-end encrypted", never as the author's
  content (list, replies, notifications, push); a person's plaintext message without a device id is marked unverified.
- Every encrypted write path (edits, thread titles, forum posts, file records, whiteboard scenes) shows the
  unknown-device warning and encrypts nothing until it is acknowledged.
- Plaintext attachments are checked against their signed SHA-256 before they are shown or saved.
- Pinned keys and verified contacts survive a sign-out (encrypted trust record with the backups).
- Decrypted attachment and thumbnail object URLs are revoked on sign-out.
- A node reporting "no identity key" no longer makes a device with local keys set up anew; an own identity change is
  judged against the key the device follows now.
