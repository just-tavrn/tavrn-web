// SPDX-License-Identifier: Apache-2.0
package org.tavrn.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The intents the app hands on as links (the manifest's intent filters let only these in). */
class LinksTest {
  @Test
  fun viewIntentsWithTavrnOrHttpsLinksAreLinks() {
    for (link in listOf(
      "tavrn://invite/chat.example/code1234",
      "tavrn://room/chat.example/01J9ZQ/01JA00",
      "tavrn://connect?session=SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS&state=ssssssssssssssss",
      "https://app.tavrn.org/invite/code1234",
      "TAVRN://invite/chat.example/code1234",
    )) {
      assertEquals(link, Links.of(Links.VIEW, link))
    }
  }

  @Test
  fun otherIntentsAndSchemesAreNot() {
    assertNull(Links.of("android.intent.action.MAIN", "tavrn://invite/chat.example/code1234"))
    assertNull(Links.of(null, "tavrn://invite/chat.example/code1234"))
    assertNull(Links.of(Links.VIEW, null))
    for (bad in listOf("http://app.tavrn.org/invite/code1234", "javascript:alert(1)", "file:///sdcard/x", "content://x/y", "tavrn", "")) {
      assertNull(bad, Links.of(Links.VIEW, bad))
    }
    assertNull(Links.of(Links.VIEW, "tavrn://invite/chat.example/" + "a".repeat(600)))
  }
}
