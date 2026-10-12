// SPDX-License-Identifier: Apache-2.0
package org.tavrn.app

/**
 * Which `VIEW` intents are links for the client (docs/ANDROID.md "Links into the app"): App Links of the project's node
 * (`https://app.tavrn.org/invite/…`, `/add/…`) and `tavrn://` links (`tavrn://invite/<node>/<code>`,
 * `tavrn://room/<node>/<room>[/<channel>]`, `tavrn://add/…`, `tavrn://connect?session=…&state=…`). This is only the
 * first filter: the Rust side checks every link again (`mobile.rs` → `deeplink.rs`), and the client shows the target
 * before it acts.
 */
object Links {
  const val VIEW = "android.intent.action.VIEW"
  private const val MAX_LINK = 512

  /** The link of an intent (its action and data URI as a string), or null. */
  fun of(action: String?, data: String?): String? {
    if (action != VIEW || data == null || data.length > MAX_LINK) return null
    val scheme = data.substringBefore(':', "").lowercase()
    return if (scheme == "https" || scheme == "tavrn") data else null
  }
}
