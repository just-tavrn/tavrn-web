// SPDX-License-Identifier: Apache-2.0
package org.tavrn.app

import android.content.Context
import android.content.SharedPreferences
import app.tauri.plugin.Channel
import app.tauri.plugin.JSObject

/**
 * State shared by the plugin, the services and the receivers of the app process (docs/ANDROID.md): the event sink to
 * the Rust side (which checks every event before the client sees it), whether the app is on screen, and the app's
 * small preferences file. Events raised before the sink exists (an app link that started the app, a tapped
 * notification) wait in a short queue.
 */
object Shell {
  private const val MAX_PENDING = 8
  private var sink: Channel? = null
  private val pending = ArrayList<JSObject>()

  /** The activity is resumed (the client is on screen and handles its own events). */
  @Volatile var visible: Boolean = false

  @Synchronized
  fun listen(channel: Channel) {
    sink = channel
    for (event in pending) channel.send(event)
    pending.clear()
  }

  /** Sends an event to the Rust side; false when nothing listens yet (it then waits, at most a few). */
  @Synchronized
  fun emit(event: JSObject): Boolean {
    val channel = sink
    if (channel != null) {
      channel.send(event)
      return true
    }
    if (pending.size < MAX_PENDING) pending.add(event)
    return false
  }

  /** The event without queueing it (the back gesture means nothing later). */
  @Synchronized
  fun emitNow(event: JSObject): Boolean {
    val channel = sink ?: return false
    channel.send(event)
    return true
  }

  fun event(kind: String): JSObject = JSObject().put("kind", kind)

  fun prefs(context: Context): SharedPreferences = context.getSharedPreferences("tavrn", Context.MODE_PRIVATE)
}
