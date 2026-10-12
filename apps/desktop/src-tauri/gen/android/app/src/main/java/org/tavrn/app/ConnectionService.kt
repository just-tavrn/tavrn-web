// SPDX-License-Identifier: Apache-2.0
package org.tavrn.app

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * "Keep a connection for notifications" (docs/ANDROID.md "Notifications without Google"): without a UnifiedPush
 * distributor, an optional foreground service keeps the app running in the background, so the client's own WebSocket
 * stays connected and the client shows its notifications natively (`notify`). It costs battery (the settings say so),
 * and closing the app from the recent apps ends it.
 */
class ConnectionService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val title = intent?.getStringExtra("title")
    val text = intent?.getStringExtra("text")
    if (title == null || text == null) {
      stopSelf()
      return START_NOT_STICKY
    }
    Notifier.channels(this)
    val notification = NotificationCompat.Builder(this, Notifier.CHANNEL_CONNECTION)
      .setSmallIcon(R.drawable.ic_notification)
      .setContentTitle(title)
      .setContentText(text)
      .setOngoing(true)
      .setSilent(true)
      .setContentIntent(Notifier.openApp(this, null, Notifier.ID_CONNECTION))
      .build()
    val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
    try {
      ServiceCompat.startForeground(this, Notifier.ID_CONNECTION, notification, type)
      running = true
    } catch (e: Exception) {
      stopSelf()
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    running = false
    super.onDestroy()
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    stopSelf()
    super.onTaskRemoved(rootIntent)
  }

  companion object {
    @Volatile var running = false

    fun start(context: Context, title: String, text: String) {
      ContextCompat.startForegroundService(context, Intent(context, ConnectionService::class.java).putExtra("title", title).putExtra("text", text))
    }

    fun stop(context: Context) {
      running = false
      context.stopService(Intent(context, ConnectionService::class.java))
    }
  }
}
