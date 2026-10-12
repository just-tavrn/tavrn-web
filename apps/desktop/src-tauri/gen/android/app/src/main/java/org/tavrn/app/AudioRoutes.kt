// SPDX-License-Identifier: Apache-2.0
package org.tavrn.app

/**
 * Which output a call uses (docs/ANDROID.md "Audio output"): the rules without Android's classes, so JUnit tests them.
 * `AudioRouter` applies them through the AudioManager.
 *
 * - A headset wins: a wired headset, else a Bluetooth headset, when one is connected.
 * - Without one the phone's speaker, for voice channels and calls alike: group voice is a room, not a phone call held to
 *   the ear (the earpiece is one tap away in the route menu).
 * - The user's choice holds while its device stays connected; a headset that connects later takes over (as phone calls
 *   do), and a choice whose device went away falls back to the rule above.
 */
object AudioRoutes {
  enum class Route(val id: String) {
    SPEAKER("speaker"),
    EARPIECE("earpiece"),
    BLUETOOTH("bluetooth"),
    WIRED("wired");

    companion object {
      fun of(id: String): Route? = entries.firstOrNull { it.id == id }
    }
  }

  /** The order of the route menu. */
  val ORDER = listOf(Route.SPEAKER, Route.EARPIECE, Route.WIRED, Route.BLUETOOTH)

  /** The route without a choice of the user. */
  fun default(available: Set<Route>): Route? = when {
    Route.WIRED in available -> Route.WIRED
    Route.BLUETOOTH in available -> Route.BLUETOOTH
    Route.SPEAKER in available -> Route.SPEAKER
    else -> available.firstOrNull()
  }

  /** The route to apply: the choice while it is available, else the default. */
  fun pick(chosen: Route?, available: Set<Route>): Route? = if (chosen != null && chosen in available) chosen else default(available)

  /** The user's choice after the devices changed from `before` to `after`: a new headset or a lost device clears it. */
  fun chosenAfter(chosen: Route?, before: Set<Route>, after: Set<Route>): Route? {
    if (chosen == null || chosen !in after) return null
    val headsetArrived = (after - before).any { it == Route.WIRED || it == Route.BLUETOOTH }
    return if (headsetArrived) null else chosen
  }

  /** The routes in the menu's order. */
  fun sorted(available: Set<Route>): List<Route> = ORDER.filter { it in available }
}
