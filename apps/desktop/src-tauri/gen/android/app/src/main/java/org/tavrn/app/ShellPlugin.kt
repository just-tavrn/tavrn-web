// SPDX-License-Identifier: Apache-2.0
package org.tavrn.app

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.unifiedpush.android.connector.INSTANCE_DEFAULT
import org.unifiedpush.android.connector.UnifiedPush

@InvokeArg class ListenArgs { lateinit var sink: Channel }
@InvokeArg class PermissionArgs { lateinit var permission: String }
@InvokeArg class PageArgs { lateinit var page: String }
@InvokeArg class UrlArgs { lateinit var url: String; var tab: Boolean = false }
@InvokeArg class PushRegisterArgs { lateinit var vapid: String; var distributor: String? = null }
@InvokeArg class PushConfigArgs { var strings: Map<String, String> = emptyMap(); var homeNode: String? = null }
@InvokeArg class KeepArgs { var on: Boolean = false; var title: String = ""; var text: String = "" }
@InvokeArg class SaveBeginArgs { lateinit var name: String; lateinit var mime: String; var size: Long = 0 }
@InvokeArg class SaveChunkArgs { lateinit var id: String; lateinit var data: String }
@InvokeArg class SaveIdArgs { lateinit var id: String }
@InvokeArg class NotifyArgs { lateinit var title: String; lateinit var body: String; var path: String? = null }
@InvokeArg class OrientationArgs { var lock: String? = null }
@InvokeArg class RouteArgs { lateinit var route: String }
@InvokeArg class PasskeyArgs { lateinit var request: String }
@InvokeArg class UnlockEntryArgs { var entry: String? = null }
@InvokeArg class UnlockStoreArgs { lateinit var entry: String; lateinit var secret: String; lateinit var title: String; lateinit var subtitle: String }
@InvokeArg class UnlockGetArgs { lateinit var entry: String; lateinit var title: String; lateinit var subtitle: String }
@InvokeArg class VoiceArgs {
  lateinit var state: String
  lateinit var title: String
  lateinit var text: String
  lateinit var mute: String
  lateinit var unmute: String
  lateinit var leave: String
  var camera: Boolean = false
}

/**
 * The Android side of the app (docs/ANDROID.md). Reached only from Rust (`src/android.rs`), never from the webview: the
 * plugin has no permission in any capability. Its events (back gesture, app links, notification taps, the voice
 * notification's buttons, insets, push endpoints) go to the Rust sink, which checks them before the client sees them.
 */
@TauriPlugin
class ShellPlugin(private val activity: Activity) : Plugin(activity) {
  private var webAuthn = false
  private var fullscreen: Fullscreen? = null
  private var insets = JSObject().put("top", 0).put("right", 0).put("bottom", 0).put("left", 0).put("keyboard", 0)

  override fun load(webView: WebView) {
    Notifier.channels(activity)
    webAuthn = enableWebAuthn(webView)
    fullscreen = Fullscreen.install(activity, webView)
    watchInsets()
    // The back gesture leaves fullscreen first, then goes to the client (history back, or the app to the background
    // from its first page); it runs before the default handlers, which would close the activity.
    (activity as AppCompatActivity).onBackPressedDispatcher.addCallback(activity, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        if (fullscreen?.exit() == true) return
        if (!Shell.emitNow(Shell.event("back"))) activity.moveTaskToBack(true)
      }
    })
    handleIntent(activity.intent)
  }

  override fun onNewIntent(intent: Intent) = handleIntent(intent)

  override fun onResume(activity: AppCompatActivity) {
    Shell.visible = true
  }

  override fun onPause(activity: AppCompatActivity) {
    Shell.visible = false
  }

  /** App links and `tavrn://` links (checked again in Rust), and taps on notifications. */
  private fun handleIntent(intent: Intent?) {
    if (intent == null) return
    intent.getStringExtra(Notifier.EXTRA_PATH)?.let { Shell.emit(Shell.event("open").put("path", it)) }
    intent.removeExtra(Notifier.EXTRA_PATH)
    val data = intent.data
    if (intent.action == Intent.ACTION_VIEW && data != null && (data.scheme == "https" || data.scheme == "tavrn")) {
      Shell.emit(Shell.event("link").put("url", data.toString()))
      intent.data = null
    }
  }

  /**
   * Passkeys in the webview (Android 14 and newer with a webview that supports it): WebAuthn for the app, which may use
   * the passkeys of the domains whose `assetlinks.json` names this app. Older systems sign in through the browser.
   */
  private fun enableWebAuthn(webView: WebView): Boolean {
    if (Build.VERSION.SDK_INT < 34 || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) return false
    return try {
      WebSettingsCompat.setWebAuthenticationSupport(webView.settings, WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP)
      WebSettingsCompat.getWebAuthenticationSupport(webView.settings) == WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP
    } catch (e: Exception) {
      false
    }
  }

  /**
   * Edge to edge: the system bars go to the client as CSS insets (it pads its layout), the keyboard shortens the
   * webview (the composer stays above it).
   */
  private fun watchInsets() {
    val content = activity.findViewById<View>(android.R.id.content) ?: return
    val density = activity.resources.displayMetrics.density
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, all ->
      val bars = all.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val ime = all.getInsets(WindowInsetsCompat.Type.ime())
      val keyboard = if (ime.bottom > bars.bottom) ime.bottom else 0
      view.setPadding(0, 0, 0, keyboard)
      insets = JSObject()
        .put("top", (bars.top / density).toDouble())
        .put("right", (bars.right / density).toDouble())
        .put("bottom", (if (keyboard > 0) 0f else bars.bottom / density).toDouble())
        .put("left", (bars.left / density).toDouble())
        .put("keyboard", (keyboard / density).toDouble())
      Shell.emitNow(JSObject(insets.toString()).put("kind", "insets"))
      all
    }
    ViewCompat.requestApplyInsets(content)
  }

  /** Passkey registration through the Credential Manager (`Passkeys.kt`); `request` is the creation options' JSON. */
  @Command
  fun passkeyCreate(invoke: Invoke) {
    val request = invoke.parseArgs(PasskeyArgs::class.java).request
    Passkeys.create(activity, request) { json, error ->
      if (json != null) invoke.resolve(JSObject().put("response", json)) else invoke.reject(error, error)
    }
  }

  /** A passkey assertion through the Credential Manager; `request` is the request options' JSON. */
  @Command
  fun passkeyGet(invoke: Invoke) {
    val request = invoke.parseArgs(PasskeyArgs::class.java).request
    Passkeys.get(activity, request) { json, error ->
      if (json != null) invoke.resolve(JSObject().put("response", json)) else invoke.reject(error, error)
    }
  }

  /**
   * Unlock with fingerprint, face or PIN (`BiometricUnlock.kt`): whether the phone can (`available`) and what is stored
   * for the entry (`stored`: `ready`, `none`, or `invalidated`, which wiped it). Never shows a prompt.
   */
  @Command
  fun unlockStatus(invoke: Invoke) {
    val entry = invoke.parseArgs(UnlockEntryArgs::class.java).entry
    val available = BiometricUnlock.availability(activity)
    val stored = if (entry == null || Build.VERSION.SDK_INT < 30) "none" else try {
      BiometricUnlock.vault(activity).stored(entry).code
    } catch (e: Exception) {
      return invoke.reject("bad entry", "unlock.invalid")
    }
    invoke.resolve(JSObject().put("available", available).put("stored", stored))
  }

  /** Seals the local storage key (base64, 32 bytes) for the entry behind the prompt. */
  @Command
  fun unlockStore(invoke: Invoke) {
    val args = invoke.parseArgs(UnlockStoreArgs::class.java)
    if (Build.VERSION.SDK_INT < 30) return invoke.reject("unsupported", BiometricUnlock.UNAVAILABLE)
    val secret = try { android.util.Base64.decode(args.secret, android.util.Base64.NO_WRAP) } catch (e: Exception) { null }
    if (secret == null || secret.size != UnlockVault.SECRET_LEN) return invoke.reject("bad secret", "unlock.invalid")
    BiometricUnlock.store(activity, args.entry, secret, args.title, args.subtitle) { error ->
      if (error == null) invoke.resolve() else invoke.reject(error, error)
    }
  }

  /** The entry's local storage key (base64) after the prompt. */
  @Command
  fun unlockGet(invoke: Invoke) {
    val args = invoke.parseArgs(UnlockGetArgs::class.java)
    if (Build.VERSION.SDK_INT < 30) return invoke.reject("unsupported", BiometricUnlock.UNAVAILABLE)
    BiometricUnlock.get(activity, args.entry, args.title, args.subtitle) { secret, error ->
      if (secret == null) return@get invoke.reject(error, error)
      val encoded = android.util.Base64.encodeToString(secret, android.util.Base64.NO_WRAP)
      secret.fill(0)
      invoke.resolve(JSObject().put("secret", encoded))
    }
  }

  /** Removes the entry's blob and key (turned off, sign-out). */
  @Command
  fun unlockClear(invoke: Invoke) {
    val entry = invoke.parseArgs(UnlockEntryArgs::class.java).entry ?: return invoke.reject("no entry", "unlock.invalid")
    if (Build.VERSION.SDK_INT >= 30) {
      try {
        BiometricUnlock.vault(activity).clear(entry)
      } catch (e: Exception) {
        return invoke.reject("bad entry", "unlock.invalid")
      }
    }
    invoke.resolve()
  }

  @Command
  fun listen(invoke: Invoke) {
    Shell.listen(invoke.parseArgs(ListenArgs::class.java).sink)
    invoke.resolve()
  }

  @Command
  fun info(invoke: Invoke) {
    val power = activity.getSystemService(Context.POWER_SERVICE) as PowerManager
    val distributors = UnifiedPush.getDistributors(activity)
    val result = JSObject()
      .put("sdk", Build.VERSION.SDK_INT)
      .put("webauthn", webAuthn)
      .put("passkeys", Passkeys.available)
      .put("origin", if (Passkeys.available) AppOrigin.of(activity) else null)
      .put("distributors", app.tauri.plugin.JSArray(distributors))
      .put("distributor", UnifiedPush.getAckDistributor(activity))
      .put("notifications", notificationState())
      .put("battery_exempt", power.isIgnoringBatteryOptimizations(activity.packageName))
      .put("keep_connection", ConnectionService.running)
      .put("insets", insets)
    invoke.resolve(result)
  }

  private fun notificationState(): String = when {
    Notifier.allowed(activity) -> "granted"
    Build.VERSION.SDK_INT >= 33 && !asked(Manifest.permission.POST_NOTIFICATIONS) -> "prompt"
    else -> "denied"
  }

  private fun asked(permission: String) = Shell.prefs(activity).getBoolean("asked.$permission", false)

  /** Asks for a runtime permission right before its first use (the client explains it). */
  @Command
  fun permission(invoke: Invoke) {
    val name = invoke.parseArgs(PermissionArgs::class.java).permission
    val wanted = when (name) {
      "notifications" -> if (Build.VERSION.SDK_INT >= 33) arrayOf(Manifest.permission.POST_NOTIFICATIONS) else emptyArray()
      "bluetooth" -> if (Build.VERSION.SDK_INT >= 31) arrayOf(Manifest.permission.BLUETOOTH_CONNECT) else emptyArray()
      "microphone" -> arrayOf(Manifest.permission.RECORD_AUDIO)
      "camera" -> arrayOf(Manifest.permission.CAMERA)
      else -> return invoke.reject("unknown permission", "android.invalid")
    }
    val granted = { wanted.all { ContextCompat.checkSelfPermission(activity, it) == PackageManager.PERMISSION_GRANTED } && (name != "notifications" || Notifier.allowed(activity)) }
    if (granted()) return invoke.resolveObject("granted")
    // Turned off in the system settings (before Android 13 notifications have no runtime permission), or denied for
    // good: only the settings can grant it now.
    val blocked = { wanted.isEmpty() || wanted.any { asked(it) && !ActivityCompat.shouldShowRequestPermissionRationale(activity, it) } }
    if (blocked()) return invoke.resolveObject("blocked")
    val prefs = Shell.prefs(activity).edit()
    wanted.forEach { prefs.putBoolean("asked.$it", true) }
    prefs.apply()
    (activity as WryActivity).requestPermissions(wanted) {
      invoke.resolveObject(if (granted()) "granted" else if (blocked()) "blocked" else "denied")
    }
  }

  @Command
  fun openSettings(invoke: Invoke) {
    val page = invoke.parseArgs(PageArgs::class.java).page
    val pkg = activity.packageName
    val intent = when (page) {
      "app" -> Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", pkg, null))
      "notifications" -> Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, pkg)
      "battery" -> Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
      else -> return invoke.reject("unknown page", "android.invalid")
    }
    start(invoke, intent)
  }

  /** The system dialog of the battery exemption; resolves whether the app is exempt afterwards. */
  @Command
  fun batteryExemption(invoke: Invoke) {
    val power = activity.getSystemService(Context.POWER_SERVICE) as PowerManager
    if (power.isIgnoringBatteryOptimizations(activity.packageName)) return invoke.resolveObject(true)
    val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${activity.packageName}"))
    try {
      (activity as WryActivity).launchActivityForResult(intent) { invoke.resolveObject(power.isIgnoringBatteryOptimizations(activity.packageName)) }
    } catch (e: ActivityNotFoundException) {
      invoke.reject("no dialog", "android.unsupported")
    }
  }

  @Command
  fun voice(invoke: Invoke) {
    val a = invoke.parseArgs(VoiceArgs::class.java)
    VoiceService.update(activity, VoiceService.Notice(a.state, a.title, a.text, a.mute, a.unmute, a.leave, a.camera))
    // The call's audio output follows the voice notification's lifetime (docs/ANDROID.md "Audio output").
    if (a.state == "disconnected") AudioRouter.stop() else AudioRouter.start(activity)
    invoke.resolve()
  }

  /** The routes of the call's audio and the one in use. */
  @Command
  fun audioRoutes(invoke: Invoke) {
    invoke.resolve(AudioRouter.state(activity))
  }

  @Command
  fun audioRoute(invoke: Invoke) {
    val route = AudioRoutes.Route.of(invoke.parseArgs(RouteArgs::class.java).route) ?: return invoke.reject("unknown route", "android.invalid")
    val state = AudioRouter.choose(activity, route) ?: return invoke.reject("route not available", "audio.unavailable")
    invoke.resolve(state)
  }

  /** `screen.orientation.lock()` of the page, which the webview does not implement: only in fullscreen (null: unlock). */
  @Command
  fun orientation(invoke: Invoke) {
    val lock = invoke.parseArgs(OrientationArgs::class.java).lock
    activity.runOnUiThread {
      if (fullscreen?.lock(lock) == true) invoke.resolve() else invoke.reject("not in fullscreen", "orientation.refused")
    }
  }

  @Command
  fun background(invoke: Invoke) {
    activity.moveTaskToBack(true)
    invoke.resolve()
  }

  /** Back to the app from the browser of the sign-in (the Custom Tab in the app's task closes). */
  @Command
  fun toFront(invoke: Invoke) {
    val intent = Intent(activity, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    try {
      activity.startActivity(intent)
    } catch (e: Exception) {
      // The user returns by themselves.
    }
    invoke.resolve()
  }

  @Command
  fun openUrl(invoke: Invoke) {
    val args = invoke.parseArgs(UrlArgs::class.java)
    val uri = Uri.parse(args.url)
    if (args.tab) {
      try {
        CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(activity, uri)
        return invoke.resolve()
      } catch (e: ActivityNotFoundException) {
        // No browser with Custom Tabs: any app that opens the link.
      }
    }
    start(invoke, Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
  }

  private fun start(invoke: Invoke, intent: Intent) {
    try {
      activity.startActivity(intent)
      invoke.resolve()
    } catch (e: ActivityNotFoundException) {
      invoke.reject("no app for this", "link.no_app")
    }
  }

  /**
   * Registers at the user's UnifiedPush distributor with the node's VAPID key and waits for the endpoint. Without a
   * chosen distributor the system's default is used (or the user picks one in the system's dialog).
   */
  @Command
  fun pushRegister(invoke: Invoke) {
    val args = invoke.parseArgs(PushRegisterArgs::class.java)
    val distributors = UnifiedPush.getDistributors(activity)
    if (distributors.isEmpty()) return invoke.reject("no distributor", "push.no_distributor")
    val register = {
      Push.await { endpoint, error -> if (endpoint != null) invoke.resolve(JSObject(endpoint.toString())) else invoke.reject(error, error) }
      try {
        UnifiedPush.register(activity, INSTANCE_DEFAULT, activity.getString(R.string.app_name), args.vapid)
      } catch (e: Exception) {
        Push.failed("push.failed")
      }
    }
    val chosen = args.distributor
    if (chosen != null && distributors.contains(chosen)) {
      UnifiedPush.saveDistributor(activity, chosen)
      register()
    } else {
      UnifiedPush.tryUseCurrentOrDefaultDistributor(activity) { ok -> if (ok) register() else invoke.reject("no distributor chosen", "push.no_distributor") }
    }
  }

  @Command
  fun pushUnregister(invoke: Invoke) {
    try {
      UnifiedPush.unregister(activity, INSTANCE_DEFAULT)
    } catch (e: Exception) {
      // Nothing registered.
    }
    Shell.prefs(activity).edit().remove(Push.KEY_ENDPOINT).apply()
    invoke.resolve()
  }

  @Command
  fun pushConfig(invoke: Invoke) {
    val args = invoke.parseArgs(PushConfigArgs::class.java)
    Push.configure(activity, args.strings, args.homeNode)
    invoke.resolve()
  }

  @Command
  fun keepConnection(invoke: Invoke) {
    val args = invoke.parseArgs(KeepArgs::class.java)
    if (args.on) ConnectionService.start(activity, args.title, args.text) else ConnectionService.stop(activity)
    invoke.resolve()
  }

  /** A save in progress: the picked document, its stream, the expected and the written size. */
  private class Save(val uri: Uri, val out: java.io.OutputStream, val size: Long, var written: Long = 0)
  private val saves = HashMap<String, Save>()

  /**
   * Downloads: Android's document picker ("Save to"), the desktop's save dialog. The content follows in chunks; at
   * most 8 saves at once.
   */
  @Command
  fun saveBegin(invoke: Invoke) {
    val args = invoke.parseArgs(SaveBeginArgs::class.java)
    if (saves.size >= 8 || args.size < 0) return invoke.reject("too many saves", "download.busy")
    val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(args.mime).putExtra(Intent.EXTRA_TITLE, args.name)
    try {
      (activity as WryActivity).launchActivityForResult(intent) { result ->
        val uri = result?.data?.data
        if (result?.resultCode != Activity.RESULT_OK || uri == null) return@launchActivityForResult invoke.resolve(JSObject().put("status", "cancelled"))
        val out = try { activity.contentResolver.openOutputStream(uri, "w") } catch (e: Exception) { null }
          ?: return@launchActivityForResult invoke.reject("cannot write", "download.failed")
        val id = java.util.UUID.randomUUID().toString()
        saves[id] = Save(uri, out, args.size)
        invoke.resolve(JSObject().put("status", "ready").put("id", id))
      }
    } catch (e: ActivityNotFoundException) {
      invoke.reject("no document picker", "download.unsupported")
    }
  }

  @Command
  fun saveChunk(invoke: Invoke) {
    val args = invoke.parseArgs(SaveChunkArgs::class.java)
    val save = saves[args.id] ?: return invoke.reject("unknown save", "download.unknown")
    val bytes = android.util.Base64.decode(args.data, android.util.Base64.DEFAULT)
    if (save.written + bytes.size > save.size) return invoke.reject("more than announced", "download.too_large")
    try {
      save.out.write(bytes)
      save.written += bytes.size
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject("write failed", "download.failed")
    }
  }

  @Command
  fun saveEnd(invoke: Invoke) {
    val id = invoke.parseArgs(SaveIdArgs::class.java).id
    val save = saves.remove(id) ?: return invoke.reject("unknown save", "download.unknown")
    try {
      save.out.flush()
      save.out.close()
    } catch (e: Exception) {
      return invoke.reject("write failed", "download.failed")
    }
    if (save.written != save.size) {
      deleteDocument(save.uri)
      return invoke.reject("incomplete", "download.incomplete")
    }
    invoke.resolve(JSObject().put("name", displayName(save.uri) ?: ""))
  }

  @Command
  fun saveAbort(invoke: Invoke) {
    val save = saves.remove(invoke.parseArgs(SaveIdArgs::class.java).id)
    if (save != null) {
      try { save.out.close() } catch (e: Exception) { }
      deleteDocument(save.uri)
    }
    invoke.resolve()
  }

  private fun deleteDocument(uri: Uri) {
    try { android.provider.DocumentsContract.deleteDocument(activity.contentResolver, uri) } catch (e: Exception) { }
  }

  private fun displayName(uri: Uri): String? = try {
    activity.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
      if (c.moveToFirst()) c.getString(0) else null
    }
  } catch (e: Exception) {
    null
  }

  /** A notification of the client (it runs in the background and decided to show one). */
  @Command
  fun notify(invoke: Invoke) {
    val args = invoke.parseArgs(NotifyArgs::class.java)
    val path = args.path ?: "/"
    Notifier.show(activity, PushRules.Shown(args.title, args.body, "client|$path", path, PushRules.Kind.MESSAGE, true))
    invoke.resolve()
  }
}
