// SPDX-License-Identifier: Apache-2.0
package org.tavrn.app

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/**
 * Where a tapped notification of the app lands (`Notifier.openApp`): this activity is not exported, so only the app's
 * own pending intents reach it, never another app's intent. It hands the notification's path to the client when it is
 * one of the app's views (`AppPaths`), brings the app to the front and finishes without showing anything. The exported
 * `MainActivity` takes no paths from intents at all (docs/ANDROID.md "Notifications").
 */
class NotificationTrampoline : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    intent?.getStringExtra(Notifier.EXTRA_PATH)?.takeIf(AppPaths::allowed)?.let { Shell.emit(Shell.event("open").put("path", it)) }
    try {
      startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
    } finally {
      finish()
    }
  }
}
