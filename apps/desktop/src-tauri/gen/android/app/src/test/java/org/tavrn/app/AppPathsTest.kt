// SPDX-License-Identifier: Apache-2.0
package org.tavrn.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The client paths a notification tap may open: the app's own views, never the sign-in pages. */
class AppPathsTest {
  @Test
  fun theViewsNotificationsOpen() {
    for (path in listOf(
      "/",
      "/rooms/01J9ZQ/channels/01JA00",
      "/rooms/01J9ZQ/channels/01JA00/threads/01JB00",
      "/rooms/01J9ZQ/settings/reports",
      "/n/chat.example/rooms/01J9ZQ/channels/01JA00",
      "/n/chat.example/conversations/01J9ZQ",
      "/conversations/01J9ZQ",
      "/settings/legal",
      "/admin/reports",
    )) {
      assertTrue(path, AppPaths.allowed(path))
    }
  }

  @Test
  fun neverTheSignInPagesOrAnythingElse() {
    for (path in listOf(
      null,
      "",
      "/connect?session=SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS&state=ssssssssssssssss",
      "/sso/callback?code=x",
      "/verify-email?token=x",
      "/login",
      "/invite/code1234",
      "/admin/reportsx",
      "/admin/users",
      "//evil.example",
      "https://evil.example/",
      "rooms/1",
      "/rooms/../connect",
      "/n/x/%2e%2e/%2e%2e/connect",
      "/rooms/1\\..\\connect",
      "/rooms/a b",
      "/rooms/" + "a".repeat(600),
    )) {
      assertFalse(path.toString(), AppPaths.allowed(path))
    }
  }
}
