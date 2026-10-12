// SPDX-License-Identifier: Apache-2.0
package org.tavrn.app

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ScreenShareRulesTest {
  @Test
  fun aPortraitPhoneIsScaledIntoTheTurnedBoxWithItsAspectRatio() {
    // 1080×2400 into the 1080p box (1920×1080, turned): the long side 2400 → 1920 would make the short side 864.
    assertEquals(Pair(864, 1920), ScreenShareRules.captureSize(1080, 2400, 1920))
    // Landscape the same way round.
    assertEquals(Pair(1920, 864), ScreenShareRules.captureSize(2400, 1080, 1920))
    // A 4:3 tablet is bound by the short side: 1536×2048 → short ≤ 1080.
    assertEquals(Pair(1080, 1440), ScreenShareRules.captureSize(1536, 2048, 1920))
  }

  @Test
  fun aSmallDisplayIsNeverUpscaledAndSizesAreEven() {
    assertEquals(Pair(720, 1280), ScreenShareRules.captureSize(720, 1280, 3840))
    assertEquals(Pair(1080, 2340), ScreenShareRules.captureSize(1081, 2341, 3840))
    val (w, h) = ScreenShareRules.captureSize(1080, 2400, 1280)
    assertTrue(w % 2 == 0 && h % 2 == 0 && h <= 1280 && w <= 720)
    assertEquals(Pair(2, 2), ScreenShareRules.captureSize(0, 0, 1280))
  }

  @Test
  fun onlyA32ByteKeyAtAnIndexOfTheRingIsTaken() {
    val key = ScreenShareRules.key(java.util.Base64.getEncoder().encodeToString(ByteArray(32) { 7 }))
    assertArrayEquals(ByteArray(32) { 7 }, key)
    assertNull(ScreenShareRules.key(java.util.Base64.getEncoder().encodeToString(ByteArray(16))))
    assertNull(ScreenShareRules.key("not base64!"))
    assertNull(ScreenShareRules.key("A".repeat(100)))
    assertTrue(ScreenShareRules.keyIndex(0) && ScreenShareRules.keyIndex(255))
    assertFalse(ScreenShareRules.keyIndex(256) || ScreenShareRules.keyIndex(-1))
  }

  @Test
  fun theStopReasonsAreTheClientsNames() {
    assertEquals(listOf("stopped", "notification", "revoked", "failed"), ScreenShareRules.Stop.values().map { it.code })
  }
}
