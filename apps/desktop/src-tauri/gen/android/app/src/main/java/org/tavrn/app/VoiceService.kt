// SPDX-License-Identifier: Apache-2.0
package org.tavrn.app

import android.Manifest
import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * The foreground service of voice (docs/ANDROID.md "Voice in the background"): while the client is connected to a
 * voice channel or a call, a persistent notification ("In voice channel X" with Mute and Leave) keeps the app and its
 * webview running with the screen off, a partial wake lock keeps the CPU awake, and the app holds the audio focus for
 * the call. Leaving voice stops it; so does closing the app from the recent apps (the webview is gone then).
 */
class VoiceService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null
  private var focus: AudioFocusRequest? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val notice = intent?.let { Notice.from(it) }
    if (notice == null) {
      stopSelf()
      return START_NOT_STICKY
    }
    Notifier.channels(this)
    try {
      ServiceCompat.startForeground(this, Notifier.ID_VOICE, notification(notice), types(this, notice.camera))
    } catch (e: Exception) {
      // Android refused the service (started from the background, a permission missing): voice still runs while the
      // app is on screen.
      stopSelf()
      return START_NOT_STICKY
    }
    hold()
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    release()
    super.onDestroy()
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    stopSelf()
    super.onTaskRemoved(rootIntent)
  }

  private fun notification(n: Notice): Notification {
    val muted = n.state == "muted" || n.state == "deafened"
    val action = { code: Int, name: String -> PendingIntent.getBroadcast(this, code, Intent(this, ActionReceiver::class.java).setAction(name), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT) }
    return NotificationCompat.Builder(this, Notifier.CHANNEL_VOICE)
      .setSmallIcon(R.drawable.ic_notification)
      .setContentTitle(n.title)
      .setContentText(n.text)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setContentIntent(Notifier.openApp(this, null, Notifier.ID_VOICE))
      .addAction(0, if (muted) n.unmute else n.mute, action(1, ActionReceiver.MUTE))
      .addAction(0, n.leave, action(2, ActionReceiver.LEAVE))
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .build()
  }

  private fun hold() {
    if (wakeLock == null) {
      val power = getSystemService(Context.POWER_SERVICE) as PowerManager
      wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "tavrn:voice").apply {
        setReferenceCounted(false)
        acquire(MAX_WAKE_MS)
      }
    }
    if (focus == null) {
      val audio = getSystemService(Context.AUDIO_SERVICE) as AudioManager
      val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
      val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN).setAudioAttributes(attributes).setOnAudioFocusChangeListener { }.build()
      if (audio.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) focus = request
    }
  }

  private fun release() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    focus?.let { (getSystemService(Context.AUDIO_SERVICE) as AudioManager).abandonAudioFocusRequest(it) }
    focus = null
    running = false
    // The app closed from the recent apps (the webview and its call are gone): the system's audio routing comes back.
    AudioRouter.stop()
  }

  /** The texts and the state the client sent (`VoiceNotice` in src/mobile.rs, checked there). */
  data class Notice(val state: String, val title: String, val text: String, val mute: String, val unmute: String, val leave: String, val camera: Boolean) {
    fun into(intent: Intent): Intent = intent
      .putExtra("state", state).putExtra("title", title).putExtra("text", text)
      .putExtra("mute", mute).putExtra("unmute", unmute).putExtra("leave", leave).putExtra("camera", camera)

    companion object {
      fun from(intent: Intent): Notice? {
        val get = { k: String -> intent.getStringExtra(k) }
        return Notice(get("state") ?: return null, get("title") ?: return null, get("text") ?: return null, get("mute") ?: return null, get("unmute") ?: return null, get("leave") ?: return null, intent.getBooleanExtra("camera", false))
      }
    }
  }

  companion object {
    /** A safety net: the wake lock ends after 12 hours even if the service were never stopped. */
    private const val MAX_WAKE_MS = 12 * 60 * 60 * 1000L
    @Volatile var running = false

    /** The service types: microphone (or media playback when listening only), plus camera while the camera is on. */
    fun types(context: Context, camera: Boolean): Int {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return 0
      val granted = { p: String -> ContextCompat.checkSelfPermission(context, p) == PackageManager.PERMISSION_GRANTED }
      var types = if (granted(Manifest.permission.RECORD_AUDIO)) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
      if (camera && granted(Manifest.permission.CAMERA)) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
      return types
    }

    fun update(context: Context, notice: Notice) {
      if (notice.state == "disconnected") {
        stop(context)
        return
      }
      running = true
      ContextCompat.startForegroundService(context, notice.into(Intent(context, VoiceService::class.java)))
    }

    fun stop(context: Context) {
      running = false
      context.stopService(Intent(context, VoiceService::class.java))
    }
  }
}
