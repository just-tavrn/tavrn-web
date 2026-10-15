// SPDX-License-Identifier: Apache-2.0
package org.tavrn.app

/**
 * The client paths a notification tap may open (docs/ANDROID.md "Notifications"): the start page, rooms and their
 * channels, threads and settings, DMs and group DMs (of this node and of other nodes), the settings and the node's
 * report inbox. Never the pages that act on a sign-in (`/connect`, `/sso/…`, `/verify-email`) or anything else. The
 * same list as `client_path` in `src/mobile.rs` and `isClientPath` in the client (`web/src/platform/shellGlue.ts`).
 */
object AppPaths {
  const val MAX_LENGTH = 512
  private val PREFIXES = listOf("/rooms/", "/n/", "/conversations/", "/dm/", "/settings/")
  private const val REPORTS = "/admin/reports"

  fun allowed(path: String?): Boolean {
    if (path == null || path.length > MAX_LENGTH || !path.startsWith("/") || path.startsWith("//")) return false
    if (path.any { it.isISOControl() || it.isWhitespace() || it == '\\' } || path.contains("%2e", ignoreCase = true)) return false
    val bare = path.substringBefore('?').substringBefore('#')
    if (bare.split('/').any { it == "." || it == ".." }) return false
    return bare == "/" || bare == REPORTS || bare.startsWith("$REPORTS/") || PREFIXES.any { bare.startsWith(it) }
  }
}
