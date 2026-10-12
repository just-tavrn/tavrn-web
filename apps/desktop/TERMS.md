# Terms of use and privacy notice for the tavrn desktop app

This notice covers the tavrn desktop app, the program you install on your computer. It is published by the tavrn
project. The project is a community of contributors and not a company or other legal entity.

## 1. Open source, no warranty

The app is open source software under the Apache License, Version 2.0, printed above. You may use, copy, change and
pass it on under that license. As sections 7 and 8 of the license say, the app is provided "as is", without
warranties or conditions of any kind, and no contributor is liable for damages arising from its use, as far as the
applicable law allows. The source code is at https://github.com/just-tavrn/tavrn-web.

The name "tavrn", the logo and the icons are not covered by the license (see TRADEMARK.md in the source code).

## 2. The node you choose

The app is a client. On its first start you choose your home node, a tavrn server run by an operator of your choice
(possibly yourself). The app talks only to that node and to the nodes it reaches for you through it (rooms and
conversations of other nodes). Your account, your messages, your files and your media are handled by those nodes:
the terms and the privacy policy of the node operator apply to them, not this notice. The tavrn project runs no node
for you and receives none of your data through the app.

End-to-end encrypted conversations are encrypted on your computer; the nodes store and forward only ciphertext. The
keys stay on your devices (section 4).

## 3. Update checks

At every start, and when you ask for it in Settings > App, the app asks whether a newer release exists in its update
channel (stable or beta, chosen in Settings > App): it requests the update file of that channel from the project's
website, https://tavrn.org/updates/desktop/ (latest.json; the Electron app: latest-linux.yml on Linux, latest.yml on
Windows, each with its signature file ending in .minisig), and the website sends it on to that file of the right
release of the repository just-tavrn/tavrn-web on github.com. The installer or package of a newer version comes from
GitHub's servers when you install it. The website receives the request like a page request and does not log your IP
address (its privacy policy, https://tavrn.org/legal/privacy/, also names the service in front of it); GitHub sees
your IP address and the request as with any download, and GitHub's privacy statement applies
(https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement). Updates are signed and
checked before they are installed.

The app sends no telemetry, no usage statistics and no crash reports, and it contains no analytics or advertising.

## 4. What the app stores on your computer, and how to remove it

- Settings: the address of your home node, the "close to tray" choice and the update channel, in config.json in the
  app's configuration folder (Linux: ~/.config/org.tavrn.desktop/, Windows: %APPDATA%\org.tavrn.desktop\).
- The data of the client: your session, the encrypted local key store with the keys of this device, and the
  settings of the client, in the storage of the app's web view (Linux: ~/.local/share/org.tavrn.desktop/,
  Windows: %LOCALAPPDATA%\org.tavrn.desktop\), and caches (Linux: ~/.cache/org.tavrn.desktop/).
- The key that unlocks the local key store, in the keychain of your operating system: the Secret Service (for
  example GNOME Keyring or KWallet) on Linux, the Credential Manager on Windows. The entries belong to the service
  "org.tavrn.desktop", one per account and node. If no keychain is available, that key is kept in the web view's
  storage instead, and Settings > App says so.

The Electron app (all Linux packages, .AppImage and .deb, and the Windows full version) stores instead:

- Settings, the encrypted key file (keychain.json) and the Chromium profile with the data of the client (your
  session, the encrypted local key store, the settings of the client, caches) in one folder: ~/.config/tavrn-desktop/
  on Linux, %APPDATA%\tavrn-desktop\ on Windows.
- The key that encrypts keychain.json, as one item named "tavrn Safe Storage" in the keychain of your operating system
  (the Secret Service on Linux; on Windows it is protected with your Windows account).

Signing out of an account removes its keys from this computer, including its keychain entry. To remove everything,
sign out, uninstall the app (on Windows the uninstaller of the Tauri app offers to delete the app data) and delete the
folders listed above; remaining keychain entries of "org.tavrn.desktop" (or the item "tavrn Safe Storage" of the
Electron app) can be deleted with the keychain's own tool (for example "Passwords and Keys" on Linux, "Credential
Manager" on Windows). Removing the Electron app (the .deb package, the .AppImage file or the Windows full version)
does not delete its folder ~/.config/tavrn-desktop/ (Windows: %APPDATA%\tavrn-desktop\): delete it yourself.

## 5. Embedded players

Links to videos and music of a few third-party services (www.youtube-nocookie.com, player.twitch.tv,
clips.twitch.tv, player.vimeo.com and open.spotify.com) can be played inside the app. Nothing is loaded from those
services until you click the player; then their own terms and privacy policies apply to what you watch or hear.
Other links open in your web browser.

## 6. Contact and source

The tavrn project: https://tavrn.org and https://github.com/just-tavrn. Questions, bug reports and security reports
go to the repositories there (see their SECURITY.md for private reports). For your account and the content on a node,
contact that node's operator.
