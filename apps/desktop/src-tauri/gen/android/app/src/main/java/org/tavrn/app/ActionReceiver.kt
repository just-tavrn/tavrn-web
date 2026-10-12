// SPDX-License-Identifier: Apache-2.0
package org.tavrn.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * The buttons of the voice notification and the screen share's "Stop sharing" (not exported: only the app's own
 * notifications reach it).
 */
class ActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == SCREEN_STOP) return ScreenShare.stop(ScreenShareRules.Stop.NOTIFICATION)
    val action = when (intent.action) {
      MUTE -> "mute"
      LEAVE -> "leave"
      else -> return
    }
    // The client mutes or leaves; it then updates (or stops) the service itself.
    if (!Shell.emitNow(Shell.event("voice").put("action", action)) && action == "leave") VoiceService.stop(context)
  }

  companion object {
    const val MUTE = "org.tavrn.app.VOICE_MUTE"
    const val LEAVE = "org.tavrn.app.VOICE_LEAVE"
    const val SCREEN_STOP = "org.tavrn.app.SCREEN_STOP"
  }
}
