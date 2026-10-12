// SPDX-License-Identifier: Apache-2.0
package org.tavrn.app

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

/**
 * The app's only activity: the bundled web client in Tauri's webview, edge to edge (the client pads itself by the
 * system bars, `ShellPlugin.watchInsets`). Everything Android-specific lives in `ShellPlugin` and the services.
 */
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}
