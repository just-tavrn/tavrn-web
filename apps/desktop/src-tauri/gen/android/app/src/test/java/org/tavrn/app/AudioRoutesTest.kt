// SPDX-License-Identifier: Apache-2.0
package org.tavrn.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.tavrn.app.AudioRoutes.Route

/** The call's audio output (docs/ANDROID.md "Audio output"): defaults, the user's choice, headsets coming and going. */
class AudioRoutesTest {
  private val phone = setOf(Route.SPEAKER, Route.EARPIECE)

  @Test
  fun withoutAHeadsetTheSpeakerPlays() {
    assertEquals(Route.SPEAKER, AudioRoutes.default(phone))
    assertEquals(Route.SPEAKER, AudioRoutes.pick(null, phone))
    // A tablet without an earpiece.
    assertEquals(Route.SPEAKER, AudioRoutes.default(setOf(Route.SPEAKER)))
    assertNull(AudioRoutes.default(emptySet()))
  }

  @Test
  fun aConnectedHeadsetWinsTheWiredOneFirst() {
    assertEquals(Route.BLUETOOTH, AudioRoutes.default(phone + Route.BLUETOOTH))
    assertEquals(Route.WIRED, AudioRoutes.default(phone + Route.WIRED))
    assertEquals(Route.WIRED, AudioRoutes.default(phone + Route.WIRED + Route.BLUETOOTH))
  }

  @Test
  fun theChoiceHoldsWhileItsDeviceIsThere() {
    assertEquals(Route.EARPIECE, AudioRoutes.pick(Route.EARPIECE, phone))
    assertEquals(Route.SPEAKER, AudioRoutes.pick(Route.SPEAKER, phone + Route.BLUETOOTH))
    // The chosen headset went away: the default again.
    assertEquals(Route.SPEAKER, AudioRoutes.pick(Route.BLUETOOTH, phone))
  }

  @Test
  fun aNewHeadsetTakesOverAndALostDeviceClearsTheChoice() {
    assertNull(AudioRoutes.chosenAfter(Route.EARPIECE, phone, phone + Route.BLUETOOTH))
    assertNull(AudioRoutes.chosenAfter(Route.SPEAKER, phone, phone + Route.WIRED))
    assertNull(AudioRoutes.chosenAfter(Route.BLUETOOTH, phone + Route.BLUETOOTH, phone))
    // Nothing new: the choice stays (the speaker over a headset that was already connected, too).
    assertEquals(Route.EARPIECE, AudioRoutes.chosenAfter(Route.EARPIECE, phone, phone))
    assertEquals(Route.SPEAKER, AudioRoutes.chosenAfter(Route.SPEAKER, phone + Route.BLUETOOTH, phone + Route.BLUETOOTH))
    // A headset leaving does not undo the choice of another route.
    assertEquals(Route.EARPIECE, AudioRoutes.chosenAfter(Route.EARPIECE, phone + Route.WIRED, phone))
    assertNull(AudioRoutes.chosenAfter(null, phone, phone + Route.WIRED))
  }

  @Test
  fun theMenuListsTheRoutesInAFixedOrderWithTheClientsNames() {
    assertEquals(listOf(Route.SPEAKER, Route.EARPIECE, Route.WIRED, Route.BLUETOOTH), AudioRoutes.sorted(setOf(Route.BLUETOOTH, Route.WIRED, Route.EARPIECE, Route.SPEAKER)))
    assertEquals(listOf("speaker", "earpiece", "wired", "bluetooth"), AudioRoutes.ORDER.map { it.id })
    assertEquals(Route.BLUETOOTH, Route.of("bluetooth"))
    assertNull(Route.of("hdmi"))
  }
}
