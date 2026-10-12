// SPDX-License-Identifier: Apache-2.0
package org.tavrn.app

import android.net.Uri
import org.json.JSONObject

/**
 * What a push of the node shows (tavrn-protocol PROTOCOL.md §6d): the port of the service worker's rules
 * (`web/public/sw.js`, `notificationFor` and `targetUrl`) for the native receiver of the Android app, so a pushed
 * message reads the same in the browser and in the app. Pure: no Android calls, tested with JUnit
 * (`PushRulesTest.kt`). Keep both in step when the payload or the texts change.
 */
object PushRules {
  /** English defaults; the client hands the translations (`push.sw.*`) with `pushConfig`. */
  val DEFAULT_STRINGS: Map<String, String> = mapOf(
    "app" to "tavrn",
    "message" to "New message from {sender}",
    "message_anonymous" to "New message",
    "mention" to "{sender} mentioned you",
    "mention_anonymous" to "You were mentioned",
    "dm" to "New message",
    "dm_encrypted" to "New encrypted message",
    "call" to "Incoming call",
    "call_from" to "{sender} is calling",
    "remote_message" to "New message on {node}",
    "remote_mention" to "You were mentioned on {node}",
    "remote_dm" to "New direct message on {node}",
    "test" to "Push notifications work on this device.",
    "generic" to "New notification",
    "report_title" to "New report",
    "report" to "New report in {room}",
    "report_node" to "A report for the node admins",
  )

  /** Vibration of a ringing call (off, on, off, on, … in milliseconds; Android's pattern starts with a pause). */
  val RING_VIBRATION = longArrayOf(0, 500, 300, 500, 300, 500)

  enum class Kind { MESSAGE, MENTION, DM, CALL, TEST, NOTICE, REPORT, GENERIC }

  data class Shown(
    val title: String,
    val body: String,
    /** A newer push of the same conversation replaces the shown one. */
    val tag: String,
    /** The client's path a tap opens. */
    val path: String,
    val kind: Kind,
    /** Mentions, direct messages, calls and the test alert again (`renotify`). */
    val important: Boolean,
  ) {
    val ring: Boolean get() = kind == Kind.CALL
  }

  /** The payload (`v` = 1), or null for anything else (the generic notification then). */
  fun parse(content: ByteArray): JSONObject? = try {
    val p = JSONObject(String(content, Charsets.UTF_8))
    if (p.optInt("v", 0) == 1) p else null
  } catch (e: Exception) {
    null
  }

  private fun fill(template: String, values: Map<String, String?>): String =
    Regex("\\{(\\w+)\\}").replace(template) { m -> values[m.groupValues[1]] ?: "" }

  private fun str(strings: Map<String, String>, key: String): String =
    strings[key]?.takeIf { it.isNotEmpty() } ?: DEFAULT_STRINGS.getValue(key)

  private fun JSONObject.text(key: String): String? = if (has(key) && !isNull(key) && get(key) is String) getString(key) else null

  private fun enc(s: String): String = Uri.encode(s)

  /** The client's route for a payload (`homeNode`: the account's home node, whose rooms need no `/n/` prefix). */
  fun targetPath(p: JSONObject?, homeNode: String?, encode: (String) -> String = ::enc): String {
    if (p != null && p.text("type") == "report") {
      val room = p.text("room_id")
      return if (room != null) "/rooms/${encode(room)}/settings/reports" else "/admin/reports"
    }
    val conversation = p?.text("conversation_id") ?: return "/"
    val node = p.text("node")
    val prefix = if (node.isNullOrEmpty() || node == homeNode) "" else "/n/${encode(node)}"
    val room = p.text("room_id")
    return if (room != null) "$prefix/rooms/${encode(room)}/channels/${encode(conversation)}" else "$prefix/conversations/${encode(conversation)}"
  }

  /** Title, body, tag, path and kind of the notification for a payload (null: the generic one). */
  fun notificationFor(p: JSONObject?, strings: Map<String, String>, homeNode: String?, encode: (String) -> String = ::enc): Shown {
    val s = { k: String -> str(strings, k) }
    val app = s("app")
    if (p == null) return Shown(app, s("generic"), "tavrn", "/", Kind.GENERIC, false)
    val type = p.text("type")
    val sender = p.text("sender")?.takeIf { it.isNotEmpty() }
    val conversation = p.text("conversation")
    val room = p.text("room")
    val node = p.text("node")
    val place = when {
      conversation != null && room != null -> "#$conversation · $room"
      room != null -> room
      else -> conversation
    }
    val encrypted = p.optBoolean("encrypted", false)
    // Never a text for an encrypted message, nor in a DM (always end-to-end encrypted): only the node could have written it.
    val text = p.text("text")?.takeIf { it.isNotEmpty() && !encrypted && type != "dm" }
    var title = app
    var body = s("generic")
    var kind = Kind.GENERIC
    if (p.has("local") && !p.optBoolean("local", true) && type != "call") {
      title = node ?: app
      body = fill(s(when (type) { "mention" -> "remote_mention"; "dm" -> "remote_dm"; else -> "remote_message" }), mapOf("node" to node))
      kind = when (type) { "mention" -> Kind.MENTION; "dm" -> Kind.DM; else -> Kind.MESSAGE }
    } else when (type) {
      "message", "mention" -> {
        title = place ?: sender ?: app
        body = when {
          text != null -> if (sender != null) "$sender: $text" else text
          sender != null -> fill(s(type), mapOf("sender" to sender))
          else -> s("${type}_anonymous")
        }
        kind = if (type == "mention") Kind.MENTION else Kind.MESSAGE
      }
      "dm" -> {
        title = conversation ?: sender ?: app
        val line = text ?: s(if (encrypted) "dm_encrypted" else "dm")
        body = if (conversation != null && sender != null) "$sender: $line" else line
        kind = Kind.DM
      }
      "call" -> {
        title = conversation ?: sender ?: app
        body = if (sender != null) fill(s("call_from"), mapOf("sender" to sender)) else s("call")
        kind = Kind.CALL
      }
      "test" -> {
        body = s("test")
        kind = Kind.TEST
      }
      "notice" -> {
        title = p.text("title")?.takeIf { it.isNotEmpty() } ?: app
        body = p.text("body")?.takeIf { it.isNotEmpty() } ?: s("generic")
        kind = Kind.NOTICE
      }
      "report" -> {
        // Only the report's kind and room travel; the inbox shows the rest.
        title = s("report_title")
        body = if (!room.isNullOrEmpty()) fill(s("report"), mapOf("room" to room)) else s("report_node")
        kind = Kind.REPORT
      }
    }
    val key = if (type == "report") "report:" + (p.text("room_id") ?: "node") else p.text("conversation_id") ?: type ?: "tavrn"
    val tag = (node ?: "") + "|" + key
    val important = type == "mention" || type == "dm" || type == "call" || type == "test"
    return Shown(title, body, tag, targetPath(p, homeNode, encode), kind, important)
  }

  /**
   * Whether the receiver shows the push: a call ring is pushed even while the client is connected, and a client on
   * screen rings by itself, so the push stays silent then (the service worker's `pageVisible`). Everything else is
   * pushed only while no client is connected.
   */
  fun shouldShow(shown: Shown, appVisible: Boolean): Boolean = !(shown.ring && appVisible)
}
