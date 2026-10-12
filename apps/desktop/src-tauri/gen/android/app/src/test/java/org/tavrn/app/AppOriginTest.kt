// SPDX-License-Identifier: Apache-2.0
package org.tavrn.app

import org.junit.Assert.assertEquals
import org.junit.Test

/** The app's WebAuthn origin (PROTOCOL.md §5a.4): base64url without padding of the certificate's SHA-256. */
class AppOriginTest {
  @Test
  fun theOriginIsTheHashOfTheCertificate() {
    // The FIPS 180-2 test vector: SHA-256("abc") = ba7816bf…f20015ad, here in base64url.
    assertEquals("android:apk-key-hash:ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0", AppOrigin.of("abc".toByteArray())) // gitleaks:allow
  }

  @Test
  fun theHashHas43CharactersWithoutPadding() {
    val origin = AppOrigin.of(ByteArray(1200) { it.toByte() })
    assertEquals(43, origin.removePrefix(AppOrigin.PREFIX).length)
    assert(!origin.contains('=') && !origin.contains('+') && !origin.contains('/'))
  }
}
