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
- Rendered messages are no longer edited as HTML strings after sanitising: link attributes, custom emojis, room
  emojis and bot mention badges are applied to DOM nodes, so text in a link title can no longer escape the
  attribute on browser engines that do not escape `<` in attribute values; `blob:` links are no longer kept.
- Legal documents no longer keep links starting with `/\`, which browsers resolve to another host.
- A forced sign-out (the home node refuses the session) now ends and forgets the sessions on other nodes like an
  explicit one; a new account never uses federated sessions of a previous one. Signing out also empties the cached
  room, DM and contact lists and removes the account's per-browser data.
- The first sign-in on a node the account has nothing on asks for confirmation instead of happening on a link visit.
- GIFs in messages follow the image preview setting and load without a referrer.
- Link previews while typing in end-to-end encrypted conversations are off by default (new privacy setting).
- No typing indicators are sent while the status is invisible.
- Object URLs of attachments keep only concrete image, audio and video types; "open original" only for those.
- Bidi control characters are stripped from displayed names and file names; profile links of other nodes are links
  only for http(s) and mailto, role colours only as `#rrggbb`; the confirmation dialog renders its word as text; the
  SSO start follows only an https provider URL.
- Desktop apps: the node picker's SRV step requires the target's certificate to be valid for the identity domain.
- Linux app (Electron): no spellchecker dictionary downloads at start; a package refuses remote debugging switches; the
  updater compares the whole parsed feed with the signed one and refuses web-installer packages.
- Windows app (Tauri): the sign-in window refuses downloads and permission requests; the native voice engine refuses
  plain `ws://`/`http://` LiveKit URLs except to this computer.
- The installers' terms describe the Electron app's folders, keychain item and update feeds.
- Invitations and call rings that a node forwards for a person of a third node show "via <node>" with an explanation.

