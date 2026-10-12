// SPDX-License-Identifier: Apache-2.0
package org.tavrn.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

/**
 * Push without Google (docs/ANDROID.md "Notifications without Google"): the UnifiedPush connector (WebPush mode) hands
 * the app an endpoint of the user's distributor (ntfy, NextPush, …) with the RFC 8291 keys it generated; the client
 * registers them at the home node as a web-push subscription through the node's existing push API (PROTOCOL.md §6d),
 * so the node encrypts its pushes for the app as for a browser. The connector decrypts them (`PushMessage.decrypted`);
 * this service then shows them with the service worker's rules (`PushRules`).
 */
class PushReceiver : PushService() {
  override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
    val keys = endpoint.pubKeySet ?: return Push.failed("push.no_keys")
    val result = Shell.event("push_endpoint").put("endpoint", endpoint.url).put("p256dh", keys.pubKey).put("auth", keys.auth)
    Shell.prefs(this).edit().putString(Push.KEY_ENDPOINT, endpoint.url).apply()
    if (!Push.complete(result)) Shell.emit(result)
  }

  override fun onMessage(message: PushMessage, instance: String) {
    // Never shown undecrypted: a push the connector could not decrypt is not from the node.
    if (!message.decrypted) return
    val prefs = Shell.prefs(this)
    val strings = HashMap<String, String>()
    prefs.getString(Push.KEY_STRINGS, null)?.let { json ->
      try {
        val o = JSONObject(json)
        for (k in o.keys()) strings[k] = o.getString(k)
      } catch (e: Exception) {
        // English defaults.
      }
    }
    val shown = PushRules.notificationFor(PushRules.parse(message.content), strings, prefs.getString(Push.KEY_HOME, null))
    if (PushRules.shouldShow(shown, Shell.visible)) Notifier.show(this, shown)
  }

  override fun onRegistrationFailed(reason: FailedReason, instance: String) {
    Push.failed(if (reason == FailedReason.NETWORK) "push.network" else "push.failed")
  }

  override fun onUnregistered(instance: String) {
    Shell.prefs(this).edit().remove(Push.KEY_ENDPOINT).apply()
    Push.failed("push.unregistered")
    Shell.emit(Shell.event("push_unregistered"))
  }
}

/** The registration the client waits for (one at a time), with a timeout. */
object Push {
  const val KEY_ENDPOINT = "push.endpoint"
  const val KEY_STRINGS = "push.strings"
  const val KEY_HOME = "push.home"
  private const val TIMEOUT_MS = 30_000L
  private val main = Handler(Looper.getMainLooper())
  private var waiting: ((JSONObject?, String?) -> Unit)? = null

  @Synchronized
  fun await(done: (JSONObject?, String?) -> Unit) {
    waiting?.invoke(null, "push.superseded")
    waiting = done
    main.postDelayed({ failed("push.timeout") }, TIMEOUT_MS)
  }

  /** Hands the endpoint to the waiting registration; false when none waits (a renewal: an event for the client). */
  @Synchronized
  fun complete(endpoint: JSONObject): Boolean {
    val done = waiting ?: return false
    waiting = null
    main.removeCallbacksAndMessages(null)
    done(endpoint, null)
    return true
  }

  @Synchronized
  fun failed(code: String) {
    val done = waiting ?: return
    waiting = null
    main.removeCallbacksAndMessages(null)
    done(null, code)
  }

  fun configure(context: Context, strings: Map<String, String>, homeNode: String?) {
    Shell.prefs(context).edit().putString(KEY_STRINGS, JSONObject(strings as Map<*, *>).toString()).putString(KEY_HOME, homeNode).apply()
  }
}
