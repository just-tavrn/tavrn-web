// SPDX-License-Identifier: Apache-2.0
package org.tavrn.app

import kotlin.math.max
import kotlin.math.min

/**
 * The decisions of the screen share (`ScreenShare.kt`, docs/ANDROID.md "Screen sharing") without Android or LiveKit,
 * so the JVM unit tests check them: the capture's size, the frame key from the bridge, why a share stopped.
 */
object ScreenShareRules {
  /** Voice frame keys are 32 bytes (ENCRYPTION.md §5a); the key index is `epoch mod 256`. */
  const val KEY_LEN = 32

  /** LiveKit's key derivation salt, the same as the web client's and the desktop engine's (ENCRYPTION.md §5a). */
  const val RATCHET_SALT = "LKFrameEncryptionKey"

  /** The ring of keys, one per epoch mod 256 (ENCRYPTION.md §5a). */
  const val KEY_RING = 256

  /**
   * The capture size: the display's aspect ratio scaled into the resolution's 16:9 box (`maxSide` × `maxSide`·9/16,
   * turned with the display), never above the display, in even numbers (video encoders want them).
   */
  fun captureSize(displayWidth: Int, displayHeight: Int, maxSide: Int): Pair<Int, Int> {
    val w = max(2, displayWidth)
    val h = max(2, displayHeight)
    val long = max(w, h).toDouble()
    val short = min(w, h).toDouble()
    val scale = minOf(1.0, maxSide / long, (maxSide * 9 / 16) / short)
    val even = { x: Double -> max(2, x.toInt() and 1.inv()) }
    return Pair(even(w * scale), even(h * scale))
  }

  /** The frame key from the bridge (standard base64, checked in Rust already): exactly 32 bytes, else null. */
  fun key(base64: String): ByteArray? {
    if (base64.length > 64) return null
    return try {
      java.util.Base64.getDecoder().decode(base64).takeIf { it.size == KEY_LEN }
    } catch (e: IllegalArgumentException) {
      null
    }
  }

  fun keyIndex(index: Int): Boolean = index in 0 until KEY_RING

  /** Why a share stopped, as the client knows the reasons (`mobile::ScreenStopReason`). */
  enum class Stop(val code: String) {
    /** The client stopped it (voice controls, the "You are streaming" bar, leaving voice). */
    STOPPED("stopped"),
    /** The notification's "Stop sharing". */
    NOTIFICATION("notification"),
    /** Android ended the projection (the system's own stop, the screen locked for good, another app took it). */
    REVOKED("revoked"),
    /** The connection broke for good or publishing failed. */
    FAILED("failed"),
  }
}
