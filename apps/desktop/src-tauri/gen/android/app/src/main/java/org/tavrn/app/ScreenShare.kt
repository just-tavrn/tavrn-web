// SPDX-License-Identifier: Apache-2.0
package org.tavrn.app

import android.Manifest
import android.app.Activity
import android.app.Notification
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import app.tauri.plugin.JSObject
import io.livekit.android.AudioOptions
import io.livekit.android.ConnectOptions
import io.livekit.android.LiveKit
import io.livekit.android.LiveKitOverrides
import io.livekit.android.RoomOptions
import io.livekit.android.audio.AudioBufferCallback
import io.livekit.android.audio.NoAudioHandler
import io.livekit.android.audio.ScreenAudioCapturer
import io.livekit.android.e2ee.BaseKeyProvider
import io.livekit.android.e2ee.E2EEManager
import io.livekit.android.e2ee.E2EEOptions
import io.livekit.android.e2ee.KeyProvider
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.participant.AudioTrackPublishOptions
import io.livekit.android.room.participant.VideoTrackPublishDefaults
import io.livekit.android.room.track.LocalAudioTrack
import io.livekit.android.room.track.LocalAudioTrackOptions
import io.livekit.android.room.track.LocalVideoTrackOptions
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.VideoCaptureParameter
import io.livekit.android.room.track.VideoEncoding
import io.livekit.android.room.track.screencapture.ScreenCaptureParams
import java.nio.ByteBuffer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import livekit.org.webrtc.FrameCryptor
import livekit.org.webrtc.FrameCryptorKeyDerivationAlgorithm

/**
 * Screen sharing (docs/ANDROID.md "Screen sharing", VOICE.md §4b). The webview cannot share the screen, so the app
 * publishes it with the LiveKit Android SDK as this device's *screen publisher*: a second LiveKit participant with the
 * token the client got from the node (`voice/join` with `role: "screen"`), which may only publish the screen share.
 *
 * - **Consent and service:** Android's own dialog (`MediaProjectionManager.createScreenCaptureIntent`), then the SDK's
 *   foreground service of type `mediaProjection` (required since Android 14) with this app's notification: "Sharing
 *   your screen" and **Stop sharing**.
 * - **Encryption:** the frames are encrypted exactly like the client's (ENCRYPTION.md §5a): one shared key per MLS
 *   epoch, HKDF with LiveKit's salt, a ring of 256 keys at `epoch mod 256`, no ratcheting, no failure limit. The keys
 *   come from the client over the bridge (`android_screen_share_start`, `android_screen_share_key`); this side never
 *   sees the MLS state, stores no key and logs none. Nothing is published before the key is set.
 * - **Nothing else:** no subscription (the token forbids it), no microphone; LiveKit's audio handling is replaced by
 *   a no-op so the call's audio routing stays `AudioRouter`'s. The sound of other apps (Android 10+, off by default)
 *   goes out as the screen share's audio track; the microphone's own samples are cleared before they are mixed.
 *
 * Its events (`screen_share` live / stopped with a reason) go to the Rust side like every other event.
 */
object ScreenShare {
  private const val TAG = "tavrn.screen"
  const val NOTIFICATION_ID = 3

  /** What the client hands over (checked in Rust, `mobile::ScreenShareStart`). */
  class Start(
    val url: String,
    val token: String,
    val key: ByteArray,
    val keyIndex: Int,
    val maxSide: Int,
    val fps: Int,
    val maxBitrate: Int,
    val audio: Boolean,
    val title: String,
    val text: String,
    val stop: String,
  )

  /** The shared key at the index of the current epoch; `getLatestKeyIndex` is the sending key for new tracks. */
  private class EpochKeys(private val base: BaseKeyProvider) : KeyProvider by base {
    @Volatile var index = 0

    fun set(key: ByteArray, index: Int) {
      base.rtcKeyProvider.setSharedKey(index, key)
      this.index = index
    }

    override fun getLatestKeyIndex(participantId: String): Int = index
  }

  /** The sound of other apps only: the microphone's samples are cleared, then the playback capture is mixed in. */
  private class AppsOnly(private val capturer: ScreenAudioCapturer) : AudioBufferCallback {
    override fun onBuffer(buffer: ByteBuffer, audioFormat: Int, channelCount: Int, sampleRate: Int, bytesRead: Int, captureTimeNs: Long): Long {
      for (i in 0 until bytesRead) buffer.put(i, 0)
      return capturer.onBuffer(buffer, audioFormat, channelCount, sampleRate, bytesRead, captureTimeNs)
    }
  }

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
  @Volatile var state = "idle"
    private set
  private var room: Room? = null
  private var keys: EpochKeys? = null
  private var appAudio: LocalAudioTrack? = null
  private var appCapturer: ScreenAudioCapturer? = null
  private var watcher: Job? = null

  /** The sound of other apps can be captured (AudioPlaybackCapture). */
  fun audioSupported(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q

  fun status(): JSObject = JSObject().put("state", state).put("audio", audioSupported())

  /** Asks Android's consent and publishes; `done(null)` once live, else an error code. */
  fun start(activity: Activity, s: Start, done: (String?) -> Unit) {
    if (state != "idle") {
      s.key.fill(0)
      return done("screen.busy")
    }
    state = "starting"
    val manager = activity.getSystemService(MediaProjectionManager::class.java)
    try {
      (activity as WryActivity).launchActivityForResult(manager.createScreenCaptureIntent()) { result ->
        val data = result?.data
        if (result?.resultCode != Activity.RESULT_OK || data == null || state != "starting") {
          state = "idle"
          s.key.fill(0)
          return@launchActivityForResult done("screen.cancelled")
        }
        scope.launch {
          try {
            publish(activity.applicationContext, s, data)
            state = "live"
            done(null)
            Shell.emit(Shell.event("screen_share").put("state", "live"))
          } catch (e: Throwable) {
            // Also errors (a native library missing): the app must not crash because a share failed.
            Log.w(TAG, "screen share failed: ${e.javaClass.simpleName}")
            release()
            done("screen.failed")
          } finally {
            s.key.fill(0)
          }
        }
      }
    } catch (e: ActivityNotFoundException) {
      state = "idle"
      s.key.fill(0)
      done("screen.unsupported")
    }
  }

  private suspend fun publish(context: Context, s: Start, consent: Intent) {
    val metrics = context.resources.displayMetrics
    val (width, height) = ScreenShareRules.captureSize(metrics.widthPixels, metrics.heightPixels, s.maxSide)
    val options = RoomOptions(
      adaptiveStream = false,
      dynacast = false,
      screenShareTrackCaptureDefaults = LocalVideoTrackOptions(isScreencast = true, captureParams = VideoCaptureParameter(width, height, s.fps)),
      screenShareTrackPublishDefaults = VideoTrackPublishDefaults(videoEncoding = VideoEncoding(s.maxBitrate, s.fps), simulcast = false, videoCodec = "vp8"),
    )
    // The call's audio belongs to the webview and AudioRouter: LiveKit must not take the audio mode or the focus.
    val overrides = LiveKitOverrides(audioOptions = AudioOptions(audioHandler = NoAudioHandler(), disableCommunicationModeWorkaround = true))
    val r = LiveKit.create(context, options, overrides)
    room = r
    // The key provider lives in WebRTC's native library, which `LiveKit.create` loads: set up after it, before connecting.
    val epochKeys = EpochKeys(
      BaseKeyProvider(
        ScreenShareRules.RATCHET_SALT, "LK-ROCKS", 0, true, -1, ScreenShareRules.KEY_RING, true,
        FrameCryptorKeyDerivationAlgorithm.HKDF,
      ),
    )
    epochKeys.set(s.key, s.keyIndex)
    keys = epochKeys
    r.e2eeOptions = E2EEOptions(epochKeys)
    r.connect(s.url, s.token, ConnectOptions(autoSubscribe = false))
    watcher = scope.launch {
      r.events.collect { e -> if (e is RoomEvent.Disconnected && state == "live") stop(ScreenShareRules.Stop.FAILED) }
    }
    val params = ScreenCaptureParams(consent, NOTIFICATION_ID, notification(context, s), onStop = { if (state == "live") stop(ScreenShareRules.Stop.REVOKED) })
    if (!r.localParticipant.setScreenShareEnabled(true, params)) throw IllegalStateException("not published")
    if (s.audio && audioSupported() && ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
      publishAppAudio(r)
    }
  }

  /** The sound of other apps as the share's audio (Android 10+): best effort, the video goes on without it. */
  private suspend fun publishAppAudio(r: Room) {
    try {
      val video = r.localParticipant.getTrackPublication(Track.Source.SCREEN_SHARE)?.track ?: return
      val capturer = ScreenAudioCapturer.createFromScreenShareTrack(video) ?: return
      val track = r.localParticipant.createAudioTrack("screen_audio", LocalAudioTrackOptions(false, false, false, false, false))
      track.setAudioBufferCallback(AppsOnly(capturer))
      r.localParticipant.publishAudioTrack(track, AudioTrackPublishOptions("screen_audio", null, false, false, Track.Source.SCREEN_SHARE_AUDIO, null, false))
      appAudio = track
      appCapturer = capturer
    } catch (e: Exception) {
      Log.w(TAG, "no app audio: ${e.javaClass.simpleName}")
    }
  }

  private fun notification(context: Context, s: Start): Notification {
    val stop = PendingIntent.getBroadcast(context, 3, Intent(context, ActionReceiver::class.java).setAction(ActionReceiver.SCREEN_STOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    Notifier.channels(context)
    return NotificationCompat.Builder(context, Notifier.CHANNEL_VOICE)
      .setSmallIcon(R.drawable.ic_notification)
      .setContentTitle(s.title)
      .setContentText(s.text)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setContentIntent(Notifier.openApp(context, null, NOTIFICATION_ID))
      .addAction(0, s.stop, stop)
      // While the screen is shared Android shows notifications in their public form only (screen-share protection,
      // Android 15+): this one holds nothing private and its Stop button must stay reachable.
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .build()
  }

  /**
   * The key of a new epoch: set at its index and made the sending key, also of the tracks already published (the
   * SDK picks a track's key index only when it publishes it).
   */
  fun setKey(key: ByteArray, index: Int): Boolean {
    val k = keys ?: return false.also { key.fill(0) }
    try {
      k.set(key, index)
    } finally {
      key.fill(0)
    }
    room?.e2eeManager?.let { sendWith(it, index) }
    return true
  }

  /** Every published track's frame cryptor encrypts with the key at `index` from now on. */
  private fun sendWith(manager: E2EEManager, index: Int) {
    try {
      val field = E2EEManager::class.java.getDeclaredField("frameCryptors").apply { isAccessible = true }
      (field.get(manager) as? Map<*, *>)?.values?.forEach { (it as? FrameCryptor)?.keyIndex = index }
    } catch (e: ReflectiveOperationException) {
      // An SDK without the field: the share keeps the key it started with, which receivers still hold.
      Log.w(TAG, "the sending key stays the first epoch's")
    }
  }

  /** Stops the share; `reason` other than STOPPED is reported to the client (it did not ask for it). */
  fun stop(reason: ScreenShareRules.Stop) {
    if (state == "idle") return
    state = "idle"
    scope.launch { release() }
    if (reason != ScreenShareRules.Stop.STOPPED) Shell.emit(Shell.event("screen_share").put("state", "stopped").put("reason", reason.code))
  }

  private suspend fun release() {
    state = "idle"
    watcher?.cancel()
    watcher = null
    val r = room
    room = null
    keys = null
    appCapturer?.releaseAudioResources()
    appCapturer = null
    appAudio = null
    try {
      r?.localParticipant?.setScreenShareEnabled(false)
    } catch (e: Exception) {
      // Gone already.
    }
    r?.disconnect()
    r?.release()
  }
}
