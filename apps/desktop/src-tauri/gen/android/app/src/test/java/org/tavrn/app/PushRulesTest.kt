// SPDX-License-Identifier: Apache-2.0
package org.tavrn.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The native receiver shows what the service worker shows: the cases of web/src/lib/push.test.ts and sw.js, from the
 * payload to the notification (title, body, tag, path) and the decision to ring.
 */
class PushRulesTest {
  /** encodeURIComponent: what the service worker uses (android.net.Uri is a stub in JVM tests). */
  private val encode = { s: String ->
    java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20").replace("%21", "!").replace("%27", "'").replace("%28", "(").replace("%29", ")").replace("%7E", "~")
  }

  private fun payload(vararg pairs: Pair<String, Any?>): JSONObject = JSONObject().apply {
    put("v", 1)
    for ((k, v) in pairs) put(k, v)
  }

  private fun shown(p: JSONObject?, strings: Map<String, String> = emptyMap(), home: String? = "tavrn.example") = PushRules.notificationFor(p, strings, home, encode)

  @Test
  fun aMessageInARoomNamesThePlaceAndTheSender() {
    val n = shown(payload("type" to "message", "conversation_id" to "c1", "room_id" to "r1", "conversation" to "general", "room" to "Gaming", "sender" to "alice", "text" to "hi", "node" to "tavrn.example"))
    assertEquals("#general · Gaming", n.title)
    assertEquals("alice: hi", n.body)
    assertEquals("tavrn.example|c1", n.tag)
    assertEquals("/rooms/r1/channels/c1", n.path)
    assertEquals(PushRules.Kind.MESSAGE, n.kind)
    assertFalse(n.important)
  }

  @Test
  fun encryptedMessagesAndDirectMessagesNeverShowAText() {
    val m = shown(payload("type" to "message", "conversation_id" to "c1", "room_id" to "r1", "room" to "Gaming", "sender" to "alice", "text" to "secret", "encrypted" to true))
    assertEquals("New message from alice", m.body)
    val dm = shown(payload("type" to "dm", "conversation_id" to "d1", "sender" to "bob", "text" to "from the node", "encrypted" to true))
    assertEquals("bob", dm.title)
    assertEquals("New encrypted message", dm.body)
    assertEquals("/conversations/d1", dm.path)
    assertTrue(dm.important)
  }

  @Test
  fun aGroupDirectMessageNamesTheConversationAndTheSender() {
    val n = shown(payload("type" to "dm", "conversation_id" to "g1", "conversation" to "Friends", "sender" to "carol"))
    assertEquals("Friends", n.title)
    assertEquals("carol: New message", n.body)
  }

  @Test
  fun mentionsUseTheTranslatedTexts() {
    val de = mapOf("mention" to "{sender} hat dich erwähnt", "app" to "tavrn")
    val n = shown(payload("type" to "mention", "conversation_id" to "c1", "room_id" to "r1", "room" to "Raum", "sender" to "alice"), de)
    assertEquals("Raum", n.title)
    assertEquals("alice hat dich erwähnt", n.body)
    assertTrue(n.important)
    val anonymous = shown(payload("type" to "mention", "conversation_id" to "c1"))
    assertEquals("You were mentioned", anonymous.body)
  }

  @Test
  fun anotherNodesConversationsGetTheNodePrefixAndOnlyANeutralText() {
    val n = shown(payload("type" to "dm", "conversation_id" to "x/1", "node" to "other.example", "local" to false, "sender" to "eve"))
    assertEquals("other.example", n.title)
    assertEquals("New direct message on other.example", n.body)
    assertEquals("/n/other.example/conversations/x%2F1", n.path)
  }

  @Test
  fun callsRingUnlessTheClientIsOnScreen() {
    val n = shown(payload("type" to "call", "conversation_id" to "d1", "sender" to "bob", "node" to "tavrn.example", "local" to false))
    assertEquals("bob is calling", n.body)
    assertTrue(n.ring)
    assertTrue(PushRules.shouldShow(n, appVisible = false))
    assertFalse(PushRules.shouldShow(n, appVisible = true))
    val message = shown(payload("type" to "message", "conversation_id" to "c1"))
    assertTrue(PushRules.shouldShow(message, appVisible = true))
  }

  @Test
  fun reportsOpenTheReportsTabOrTheAdminInbox() {
    val room = shown(payload("type" to "report", "room_id" to "r1", "room" to "Gaming"))
    assertEquals("New report", room.title)
    assertEquals("New report in Gaming", room.body)
    assertEquals("/rooms/r1/settings/reports", room.path)
    assertEquals("|report:r1", room.tag)
    val node = shown(payload("type" to "report"))
    assertEquals("A report for the node admins", node.body)
    assertEquals("/admin/reports", node.path)
  }

  @Test
  fun noticesAndTestsAndUnknownPayloads() {
    assertEquals("Maintenance", shown(payload("type" to "notice", "title" to "Maintenance", "body" to "at 10")).title)
    assertEquals("Push notifications work on this device.", shown(payload("type" to "test")).body)
    val generic = shown(null)
    assertEquals("tavrn", generic.title)
    assertEquals("New notification", generic.body)
    assertEquals("/", generic.path)
  }

  @Test
  fun onlyVersionOnePayloadsAreRead() {
    assertNull(PushRules.parse("{\"v\":2,\"type\":\"dm\"}".toByteArray()))
    assertNull(PushRules.parse("not json".toByteArray()))
    assertEquals("dm", PushRules.parse("{\"v\":1,\"type\":\"dm\"}".toByteArray())?.getString("type"))
  }
}
