// SPDX-License-Identifier: Apache-2.0
package org.tavrn.app

import android.app.Activity
import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Message
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * The Fullscreen API in the app's webview (docs/ANDROID.md "Fullscreen"). A webview shows `element.requestFullscreen()`
 * through its chrome client: `onShowCustomView` hands over a view with the fullscreen content, `onHideCustomView` takes
 * it back. Tauri's chrome client (wry's `RustWebChromeClient`, generated into this project and final) refuses at once
 * (it calls `onCustomViewHidden` right away), so the fullscreen button of streams and cameras did nothing. This client
 * wraps it: everything else goes to wry's client unchanged, the custom view fills the activity with the system bars
 * hidden (immersive: a swipe shows them for a moment), and leaving fullscreen (the client's button, Escape, the back
 * gesture) restores the bars and the orientation.
 *
 * The Screen Orientation API (`screen.orientation.lock`) is not implemented by Android's webview; the client's shell
 * wiring (`web/src/platform/androidShell.ts`) routes a refused lock to [lock], which allows it only while in fullscreen,
 * as browsers do, and fullscreen's end always releases it.
 */
class Fullscreen(private val activity: Activity, private val inner: WebChromeClient) : WebChromeClient() {
  private var view: View? = null
  private var callback: CustomViewCallback? = null
  private var savedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED

  /** The webview shows an element in fullscreen. */
  val active: Boolean get() = view != null

  override fun onShowCustomView(view: View, callback: CustomViewCallback) {
    if (this.view != null) {
      callback.onCustomViewHidden()
      return
    }
    this.view = view
    this.callback = callback
    savedOrientation = activity.requestedOrientation
    view.setBackgroundColor(Color.BLACK)
    decor().addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    bars().apply {
      systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      hide(WindowInsetsCompat.Type.systemBars())
    }
  }

  override fun onHideCustomView() {
    val shown = view ?: return
    view = null
    callback = null
    decor().removeView(shown)
    bars().show(WindowInsetsCompat.Type.systemBars())
    activity.requestedOrientation = savedOrientation
  }

  /** Leaves fullscreen (the back gesture); false when nothing is in fullscreen. */
  fun exit(): Boolean {
    val cb = callback ?: return false
    // The webview leaves fullscreen (the page sees `fullscreenchange`) and hands the view back.
    cb.onCustomViewHidden()
    onHideCustomView()
    return true
  }

  /**
   * The orientation the page asked for (`screen.orientation.lock`, a name of the Screen Orientation API), only in
   * fullscreen; null releases it. False when refused.
   */
  fun lock(orientation: String?): Boolean {
    if (orientation == null) {
      if (active) activity.requestedOrientation = savedOrientation
      return true
    }
    val wanted = orientationOf(orientation) ?: return false
    if (!active) return false
    activity.requestedOrientation = wanted
    return true
  }

  private fun decor(): FrameLayout = activity.window.decorView as FrameLayout

  private fun bars() = WindowCompat.getInsetsController(activity.window, activity.window.decorView)

  // Everything else is wry's: permissions (camera, microphone), file choosers, dialogs, the console, the title.
  override fun onPermissionRequest(request: PermissionRequest) = inner.onPermissionRequest(request)
  override fun onPermissionRequestCanceled(request: PermissionRequest) = inner.onPermissionRequestCanceled(request)
  override fun onShowFileChooser(webView: WebView, filePathCallback: ValueCallback<Array<Uri>>, fileChooserParams: FileChooserParams): Boolean =
    inner.onShowFileChooser(webView, filePathCallback, fileChooserParams)
  override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult): Boolean = inner.onJsAlert(view, url, message, result)
  override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean = inner.onJsConfirm(view, url, message, result)
  override fun onJsPrompt(view: WebView, url: String, message: String, defaultValue: String?, result: JsPromptResult): Boolean =
    inner.onJsPrompt(view, url, message, defaultValue, result)
  override fun onJsBeforeUnload(view: WebView, url: String, message: String, result: JsResult): Boolean = inner.onJsBeforeUnload(view, url, message, result)
  override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) = inner.onGeolocationPermissionsShowPrompt(origin, callback)
  override fun onGeolocationPermissionsHidePrompt() = inner.onGeolocationPermissionsHidePrompt()
  override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean = inner.onConsoleMessage(consoleMessage)
  override fun onReceivedTitle(view: WebView, title: String?) = inner.onReceivedTitle(view, title)
  override fun onReceivedIcon(view: WebView, icon: Bitmap?) = inner.onReceivedIcon(view, icon)
  override fun onProgressChanged(view: WebView, newProgress: Int) = inner.onProgressChanged(view, newProgress)
  override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message?): Boolean = inner.onCreateWindow(view, isDialog, isUserGesture, resultMsg)
  override fun onCloseWindow(window: WebView) = inner.onCloseWindow(window)
  override fun onRequestFocus(view: WebView) = inner.onRequestFocus(view)
  override fun getDefaultVideoPoster(): Bitmap? = inner.defaultVideoPoster
  override fun getVideoLoadingProgressView(): View? = inner.videoLoadingProgressView

  companion object {
    /** The Screen Orientation API's names (`OrientationLockType`) as activity orientations. */
    fun orientationOf(name: String): Int? = when (name) {
      "any" -> ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR
      "natural" -> ActivityInfo.SCREEN_ORIENTATION_NOSENSOR
      "landscape" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
      "portrait" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
      "landscape-primary" -> ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
      "landscape-secondary" -> ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE
      "portrait-primary" -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
      "portrait-secondary" -> ActivityInfo.SCREEN_ORIENTATION_REVERSE_PORTRAIT
      else -> null
    }

    /** Wraps the webview's chrome client (wry's) once; the plugin calls it when it loads. */
    fun install(activity: Activity, webView: WebView): Fullscreen {
      val current = webView.webChromeClient
      if (current is Fullscreen) return current
      return Fullscreen(activity, current ?: WebChromeClient()).also { webView.webChromeClient = it }
    }
  }
}
