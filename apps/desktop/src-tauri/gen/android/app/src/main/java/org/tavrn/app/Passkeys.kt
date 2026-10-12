// SPDX-License-Identifier: Apache-2.0
package org.tavrn.app

import android.app.Activity
import android.os.Build
import androidx.appcompat.app.AppCompatActivity
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialNoCreateOptionException
import androidx.credentials.exceptions.CreateCredentialProviderConfigurationException
import androidx.credentials.exceptions.CreateCredentialUnsupportedException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialProviderConfigurationException
import androidx.credentials.exceptions.GetCredentialUnsupportedException
import androidx.credentials.exceptions.NoCredentialException
import androidx.credentials.exceptions.publickeycredential.CreatePublicKeyCredentialDomException
import androidx.credentials.exceptions.publickeycredential.GetPublicKeyCredentialDomException
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

/**
 * Passkeys of the Android app (docs/ANDROID.md "Passkeys"): the ceremony runs through Android's Credential Manager
 * (androidx.credentials, the framework's own on Android 14 and newer; no Google library), as a native app's. Android
 * checks that the relying party's `assetlinks.json` lists this app and puts the app's origin
 * (`android:apk-key-hash:…`, [AppOrigin]) into `clientDataJSON`; the node accepts it when it lists that origin in
 * `webauthn.origins`. The webview's own WebAuthn cannot be used: it checks the relying party id against the page's
 * origin (`https://tauri.localhost`) and refuses the node's (`SecurityError`).
 *
 * Reached only from Rust (`src/passkey.rs` checked the options and the relying party id first).
 */
object Passkeys {
  const val CANCELLED = "passkey.cancelled"
  const val EXISTS = "passkey.exists"
  const val REFUSED = "passkey.refused"
  const val UNAVAILABLE = "passkey.unavailable"
  const val FAILED = "passkey.failed"

  /** The framework's Credential Manager, without Google's library: Android 14 (API 34) and newer. */
  val available: Boolean get() = Build.VERSION.SDK_INT >= 34

  /** A WebAuthn DOMException name of the Credential Manager (`androidx.credentials.TYPE_…_ERROR`) as the client's code. */
  fun dom(type: String): String = when {
    type.endsWith("INVALID_STATE_ERROR") -> EXISTS
    type.endsWith("NOT_ALLOWED_ERROR") || type.endsWith("ABORT_ERROR") || type.endsWith("TIMEOUT_ERROR") -> CANCELLED
    type.endsWith("SECURITY_ERROR") -> REFUSED
    type.endsWith("NOT_SUPPORTED_ERROR") -> UNAVAILABLE
    else -> FAILED
  }

  /** A failed ceremony as the code the client turns into a browser's error (`web/src/platform/tauriPasskeys.ts`). */
  fun code(e: Throwable): String = when (e) {
    is CreateCredentialCancellationException, is GetCredentialCancellationException, is NoCredentialException -> CANCELLED
    is CreatePublicKeyCredentialDomException -> dom(e.domError.type)
    is GetPublicKeyCredentialDomException -> dom(e.domError.type)
    is CreateCredentialProviderConfigurationException, is GetCredentialProviderConfigurationException,
    is CreateCredentialUnsupportedException, is GetCredentialUnsupportedException,
    is CreateCredentialNoCreateOptionException -> UNAVAILABLE
    else -> FAILED
  }

  /** Registration: `request` is `PublicKeyCredentialCreationOptionsJSON`; answers `RegistrationResponseJSON`. */
  fun create(activity: Activity, request: String, done: (String?, String?) -> Unit) {
    if (!available) return done(null, UNAVAILABLE)
    val manager = CredentialManager.create(activity)
    (activity as AppCompatActivity).lifecycleScope.launch {
      try {
        val response = manager.createCredential(activity, CreatePublicKeyCredentialRequest(request))
        val json = (response as? CreatePublicKeyCredentialResponse)?.registrationResponseJson
        if (json == null) done(null, FAILED) else done(json, null)
      } catch (e: Exception) {
        done(null, code(e))
      }
    }
  }

  /** Assertion: `request` is `PublicKeyCredentialRequestOptionsJSON`; answers `AuthenticationResponseJSON`. */
  fun get(activity: Activity, request: String, done: (String?, String?) -> Unit) {
    if (!available) return done(null, UNAVAILABLE)
    val manager = CredentialManager.create(activity)
    (activity as AppCompatActivity).lifecycleScope.launch {
      try {
        val response = manager.getCredential(activity, GetCredentialRequest(listOf(GetPublicKeyCredentialOption(request))))
        val json = (response.credential as? PublicKeyCredential)?.authenticationResponseJson
        if (json == null) done(null, FAILED) else done(json, null)
      } catch (e: Exception) {
        done(null, code(e))
      }
    }
  }
}
