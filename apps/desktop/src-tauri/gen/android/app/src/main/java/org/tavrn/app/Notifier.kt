// SPDX-License-Identifier: Apache-2.0
package org.tavrn.app

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/**
 * The app's notification channels and its notifications (docs/ANDROID.md "Notifications"): messages and mentions
 * (pushed by the node, or shown by the client while it runs in the background), call rings (full-screen, vibrating),
 * the voice service's persistent notification and the one of "Keep a connection for notifications".
 */
object Notifier {
  const val CHANNEL_MESSAGES = "messages"
  const val CHANNEL_CALLS = "calls"
  const val CHANNEL_VOICE = "voice"
  const val CHANNEL_CONNECTION = "connection"
  /** The extra of a tap: the client's path to open. */
  const val EXTRA_PATH = "org.tavrn.app.PATH"

  const val ID_VOICE = 1
  const val ID_CONNECTION = 2

  fun channels(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    val res = context.resources
    manager.createNotificationChannels(listOf(
      NotificationChannel(CHANNEL_MESSAGES, res.getString(R.string.channel_messages), NotificationManager.IMPORTANCE_HIGH),
      NotificationChannel(CHANNEL_CALLS, res.getString(R.string.channel_calls), NotificationManager.IMPORTANCE_HIGH).apply {
        enableVibration(true)
        vibrationPattern = PushRules.RING_VIBRATION
      },
      NotificationChannel(CHANNEL_VOICE, res.getString(R.string.channel_voice), NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) },
      NotificationChannel(CHANNEL_CONNECTION, res.getString(R.string.channel_connection), NotificationManager.IMPORTANCE_MIN).apply { setShowBadge(false) },
    ))
  }

  /** Opens the app (and `path` in the client). */
  fun openApp(context: Context, path: String?, requestCode: Int): PendingIntent {
    val intent = Intent(context, MainActivity::class.java)
      .setAction(Intent.ACTION_VIEW)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    if (path != null) intent.putExtra(EXTRA_PATH, path)
    return PendingIntent.getActivity(context, requestCode, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  fun allowed(context: Context): Boolean =
    NotificationManagerCompat.from(context).areNotificationsEnabled() &&
      (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)

  /** Shows a message, mention, call ring or notice. */
  fun show(context: Context, shown: PushRules.Shown) {
    if (!allowed(context)) return
    channels(context)
    val code = shown.tag.hashCode()
    val builder = NotificationCompat.Builder(context, if (shown.ring) CHANNEL_CALLS else CHANNEL_MESSAGES)
      .setSmallIcon(R.drawable.ic_notification)
      .setContentTitle(shown.title)
      .setContentText(shown.body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(shown.body))
      .setAutoCancel(true)
      .setOnlyAlertOnce(!shown.important)
      .setContentIntent(openApp(context, shown.path, code))
      .setCategory(if (shown.ring) NotificationCompat.CATEGORY_CALL else NotificationCompat.CATEGORY_MESSAGE)
      .setPriority(if (shown.ring) NotificationCompat.PRIORITY_MAX else NotificationCompat.PRIORITY_HIGH)
    if (shown.ring) {
      builder.setVibrate(PushRules.RING_VIBRATION).setOngoing(false).setTimeoutAfter(60_000)
      // A ring on a locked screen shows the app (the client's incoming-call view), as a phone call does.
      builder.setFullScreenIntent(openApp(context, shown.path, code + 1), true)
    }
    try {
      NotificationManagerCompat.from(context).notify(shown.tag, 0, builder.build())
    } catch (e: SecurityException) {
      // The permission was revoked in between: nothing to show.
    }
  }

  fun cancel(context: Context, tag: String) = NotificationManagerCompat.from(context).cancel(tag, 0)
}
