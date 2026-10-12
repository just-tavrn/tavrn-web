// SPDX-License-Identifier: Apache-2.0
package org.tavrn.app

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import org.tavrn.app.AudioRoutes.Route

/**
 * The call's audio output (docs/ANDROID.md "Audio output"): speaker, earpiece, a wired or a Bluetooth headset. Runs
 * while the client is in a voice channel or a call (the voice notification's lifetime, `ShellPlugin.voice`), in the app
 * process and independent of the activity, so the route stays with the screen off and the app in the background.
 *
 * Android 12 and newer: `AudioManager.setCommunicationDevice` (Bluetooth SCO included, the system connects it). Older
 * systems: the speakerphone switch and Bluetooth SCO by hand. The webview's WebRTC audio follows the communication
 * route (the app holds `MODE_IN_COMMUNICATION` while voice runs). The webview itself also picks a route when headsets
 * come and go; this router answers each change a moment later with the user's choice ([AudioRoutes]).
 */
object AudioRouter {
  private const val SETTLE_MS = 300L
  private const val REASSERT_MS = 1000L

  private val handler = Handler(Looper.getMainLooper())
  private var audio: AudioManager? = null
  private var running = false
  private var chosen: Route? = null
  private var available: Set<Route> = emptySet()
  private var applied: Route? = null
  private var appliedAt = 0L
  private var savedMode = AudioManager.MODE_NORMAL
  private var sco = false
  private var listener: Any? = null

  private val devices = object : AudioDeviceCallback() {
    override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) = settle()
    override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) = settle()
  }
  private val refresh = Runnable { refresh() }

  private fun manager(context: Context): AudioManager =
    audio ?: (context.applicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager).also { audio = it }

  /** Voice started: the communication mode, the route by the rules, and listening to devices coming and going. */
  @Synchronized
  fun start(context: Context) {
    if (running) return
    val am = manager(context)
    running = true
    savedMode = am.mode
    try {
      am.mode = AudioManager.MODE_IN_COMMUNICATION
    } catch (e: Exception) {
      // Another app holds a call; the route still applies to the webview's audio where it can.
    }
    am.registerAudioDeviceCallback(devices, handler)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val l = AudioManager.OnCommunicationDeviceChangedListener { onSystemChange() }
      am.addOnCommunicationDeviceChangedListener(context.mainExecutor, l)
      listener = l
    }
    available = scan(am)
    apply(am)
    emit()
  }

  /** Voice ended: the system's routing and mode come back; the next call starts with the rules again. */
  @Synchronized
  fun stop() {
    if (!running) return
    val am = audio ?: return
    running = false
    handler.removeCallbacks(refresh)
    am.unregisterAudioDeviceCallback(devices)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      (listener as? AudioManager.OnCommunicationDeviceChangedListener)?.let { am.removeOnCommunicationDeviceChangedListener(it) }
      listener = null
      am.clearCommunicationDevice()
    } else {
      legacy(am, null)
    }
    try {
      am.mode = if (savedMode == AudioManager.MODE_IN_COMMUNICATION) AudioManager.MODE_NORMAL else savedMode
    } catch (e: Exception) {
      // Nothing to restore.
    }
    chosen = null
    applied = null
    emit()
  }

  /** The user picked a route in the client; an unavailable one is refused (null). */
  @Synchronized
  fun choose(context: Context, route: Route): JSObject? {
    val am = manager(context)
    if (!running) available = scan(am)
    if (route !in available) return null
    chosen = route
    if (running) apply(am)
    return state(context)
  }

  /** What the client shows: the routes in the menu's order and the one in use (null while no voice runs). */
  @Synchronized
  fun state(context: Context): JSObject {
    val am = manager(context)
    val list = if (running) available else scan(am)
    return JSObject()
      .put("available", JSArray(AudioRoutes.sorted(list).map { it.id }))
      .put("current", (if (running) current(am) else null)?.id)
  }

  private fun emit() {
    val am = audio ?: return
    val list = if (running) available else scan(am)
    Shell.emitNow(
      JSObject().put("kind", "audio_routes").put("available", JSArray(AudioRoutes.sorted(list).map { it.id })).put("current", (if (running) current(am) else null)?.id),
    )
  }

  /** Devices changed: wait until the webview reacted, then apply the rules (and the user's choice) again. */
  private fun settle() {
    handler.removeCallbacks(refresh)
    handler.postDelayed(refresh, SETTLE_MS)
  }

  @Synchronized
  private fun refresh() {
    val am = audio ?: return
    if (!running) return
    val after = scan(am)
    chosen = AudioRoutes.chosenAfter(chosen, available, after)
    available = after
    apply(am)
    emit()
  }

  /** Someone else (the webview) moved the call's audio: show it, and put the chosen route back once. */
  @Synchronized
  private fun onSystemChange() {
    val am = audio ?: return
    if (!running) return
    if (current(am) != applied && SystemClock.elapsedRealtime() - appliedAt > REASSERT_MS) settle() else emit()
  }

  private fun apply(am: AudioManager) {
    val route = AudioRoutes.pick(chosen, available) ?: return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val device = am.availableCommunicationDevices.firstOrNull { routeOf(it.type) == route } ?: return
      if (am.communicationDevice?.id != device.id) am.setCommunicationDevice(device)
    } else {
      legacy(am, route)
    }
    applied = route
    appliedAt = SystemClock.elapsedRealtime()
  }

  /** Below Android 12: the speakerphone switch, Bluetooth SCO by hand (null: everything off). */
  @Suppress("DEPRECATION")
  private fun legacy(am: AudioManager, route: Route?) {
    val bluetooth = route == Route.BLUETOOTH
    if (!bluetooth && sco) {
      am.isBluetoothScoOn = false
      am.stopBluetoothSco()
      sco = false
    }
    am.isSpeakerphoneOn = route == Route.SPEAKER
    if (bluetooth && !sco) {
      am.startBluetoothSco()
      am.isBluetoothScoOn = true
      sco = true
    }
  }

  private fun current(am: AudioManager): Route? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) am.communicationDevice?.let { routeOf(it.type) } ?: applied else applied

  /** The outputs a call can use now. */
  private fun scan(am: AudioManager): Set<Route> {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return am.availableCommunicationDevices.mapNotNull { routeOf(it.type) }.toSet()
    val found = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).mapNotNull { routeOf(it.type) }.toMutableSet()
    // A plugged headset takes the earpiece's place (the speakerphone switch cannot pick one over the other).
    if (Route.WIRED in found) found.remove(Route.EARPIECE)
    return found
  }

  private fun routeOf(type: Int): Route? = when (type) {
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> Route.SPEAKER
    AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> Route.EARPIECE
    AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_USB_HEADSET -> Route.WIRED
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> Route.BLUETOOTH
    else -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && type == AudioDeviceInfo.TYPE_BLE_HEADSET) Route.BLUETOOTH else null
  }
}
