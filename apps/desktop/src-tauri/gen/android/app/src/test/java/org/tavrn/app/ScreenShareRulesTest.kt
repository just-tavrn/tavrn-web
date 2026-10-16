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
  fun theBoxIsLandscapeAndTurnsWithThePhone() {
    // The SDK gets the landscape box whichever way the share starts, and turns it with the display.
    val box = ScreenShareRules.captureBox(1080, 2400, 1920)
    assertEquals(Pair(1920, 864), box)
    assertEquals(box, ScreenShareRules.captureBox(2400, 1080, 1920))
    // Portrait → landscape → portrait: the frame is the screen's own shape each time, never letterboxed.
    assertEquals(Pair(864, 1920), ScreenShareRules.oriented(box, 1080, 2400))
    assertEquals(Pair(1920, 864), ScreenShareRules.oriented(box, 2400, 1080))
    assertEquals(Pair(864, 1920), ScreenShareRules.oriented(box, 1080, 2400))
    for ((w, h) in listOf(1080 to 2400, 2400 to 1080, 1536 to 2048, 2048 to 1536, 720 to 1280)) {
      assertEquals(ScreenShareRules.captureSize(w, h, 1920), ScreenShareRules.oriented(ScreenShareRules.captureBox(w, h, 1920), w, h))
    }
  }

  @Test
  fun aSquareishOrFoldedScreenGetsItsOwnBox() {
    // An unfolded foldable (nearly square) is bound by the short side, in both orientations.
    val unfolded = ScreenShareRules.captureBox(1812, 2176, 1920)
    assertEquals(Pair(1296, 1080), unfolded)
    assertEquals(Pair(1080, 1296), ScreenShareRules.oriented(unfolded, 1812, 2176))
    assertEquals(Pair(1296, 1080), ScreenShareRules.oriented(unfolded, 2176, 1812))
    // Folded to the narrow cover screen the box changes with the aspect ratio (the share follows it).
    val folded = ScreenShareRules.captureBox(904, 2316, 1920)
    assertEquals(Pair(1918, 748), folded)
    assertEquals(Pair(748, 1918), ScreenShareRules.oriented(folded, 904, 2316))
    // A square screen comes out square either way; sides stay even and within the box.
    assertEquals(Pair(1080, 1080), ScreenShareRules.oriented(ScreenShareRules.captureBox(1800, 1800, 1920), 1800, 1800))
    val (w, h) = ScreenShareRules.captureBox(1081, 2341, 1280)
    assertTrue(w % 2 == 0 && h % 2 == 0 && w <= 1280 && h <= 720 && w > h)
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
