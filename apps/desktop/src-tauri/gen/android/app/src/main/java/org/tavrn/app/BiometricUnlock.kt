// SPDX-License-Identifier: Apache-2.0
package org.tavrn.app

import android.app.Activity
import android.content.Context
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricManager.Authenticators
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import androidx.annotation.RequiresApi
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/**
 * Unlock with fingerprint, face or PIN (docs/ANDROID.md): the Android half of [UnlockVault]. Its keys live in the
 * Android Keystore (StrongBox when the phone has one, else the TEE), AES-256-GCM, usable only for one operation right
 * after the user authenticated with a strong biometric or the device's PIN, pattern or password
 * (`setUserAuthenticationParameters(0, …)`), and invalidated by Android when biometrics are enrolled or the screen
 * lock is removed. The prompt is the framework's BiometricPrompt with the device credential as the alternative, which
 * needs Android 11 (API 30) for a key of one operation: older systems do not offer the biometric unlock.
 *
 * Reached only from Rust (`src/android.rs`), which built the entry from the home node and the account and checked the
 * prompt's texts and the secret.
 */
object BiometricUnlock {
  const val CANCELLED = "unlock.cancelled"
  const val LOCKOUT = "unlock.lockout"
  const val UNAVAILABLE = "unlock.unavailable"
  const val BUSY = "unlock.busy"
  const val FAILED = "unlock.failed"

  private const val ALLOWED = Authenticators.BIOMETRIC_STRONG or Authenticators.DEVICE_CREDENTIAL

  /** The prompt now on screen (one at a time). */
  private var active: CancellationSignal? = null

  @RequiresApi(30)
  fun vault(context: Context) = UnlockVault(KeystoreKeys, UnlockVault.DirFiles(File(context.noBackupFilesDir, "unlock")))

  /**
   * `ready` (a strong biometric or a screen lock is set up), `no_lock` (neither: the phone has no screen lock),
   * `unsupported` (older than Android 11), `unavailable` (anything else, for instance a pending security update).
   */
  fun availability(context: Context): String {
    if (Build.VERSION.SDK_INT < 30) return "unsupported"
    val manager = context.getSystemService(BiometricManager::class.java) ?: return "unavailable"
    return when (manager.canAuthenticate(ALLOWED)) {
      BiometricManager.BIOMETRIC_SUCCESS -> "ready"
      BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> "no_lock"
      else -> "unavailable"
    }
  }

  /** Stores `secret` for `entry` behind a prompt; `done(error)` with null on success. The secret is zeroed. */
  @RequiresApi(30)
  fun store(activity: Activity, entry: String, secret: ByteArray, title: String, subtitle: String, done: (String?) -> Unit) {
    if (availability(activity) != "ready") {
      secret.fill(0)
      return done(UNAVAILABLE)
    }
    val vault = vault(activity)
    val cipher = try {
      vault.beginStore(entry)
    } catch (e: Exception) {
      secret.fill(0)
      vault.clear(entry)
      return done(FAILED)
    }
    prompt(activity, cipher, title, subtitle) { authenticated, error ->
      try {
        if (authenticated == null) {
          vault.clear(entry)
          done(error)
        } else {
          vault.finishStore(entry, authenticated, secret)
          done(null)
        }
      } catch (e: Exception) {
        vault.clear(entry)
        done(FAILED)
      } finally {
        secret.fill(0)
      }
    }
  }

  /** Opens the secret of `entry` behind a prompt: `done(secret, null)` or `done(null, error)`. */
  @RequiresApi(30)
  fun get(activity: Activity, entry: String, title: String, subtitle: String, done: (ByteArray?, String?) -> Unit) {
    if (availability(activity) != "ready") return done(null, UNAVAILABLE)
    val vault = vault(activity)
    val opening = try {
      vault.beginGet(entry)
    } catch (e: UnlockVault.Missing) {
      return done(null, "unlock.none")
    } catch (e: UnlockVault.Invalidated) {
      return done(null, "unlock.invalidated")
    } catch (e: Exception) {
      return done(null, FAILED)
    }
    prompt(activity, opening.cipher, title, subtitle) { authenticated, error ->
      if (authenticated == null) return@prompt done(null, error)
      try {
        done(vault.finishGet(entry, UnlockVault.Opening(authenticated, opening.sealed)), null)
      } catch (e: UnlockVault.Invalidated) {
        done(null, "unlock.invalidated")
      } catch (e: Exception) {
        done(null, FAILED)
      }
    }
  }

  /** The prompt over the app, with the cipher it authenticates; `done(cipher, null)` or `done(null, error)`. */
  @RequiresApi(30)
  private fun prompt(activity: Activity, cipher: Cipher, title: String, subtitle: String, done: (Cipher?, String?) -> Unit) {
    activity.runOnUiThread {
      if (active != null) return@runOnUiThread done(null, BUSY)
      val signal = CancellationSignal()
      active = signal
      val finish = { c: Cipher?, e: String? ->
        if (active === signal) active = null
        done(c, e)
      }
      try {
        val prompt = BiometricPrompt.Builder(activity)
          .setTitle(title)
          .setSubtitle(subtitle)
          .setAllowedAuthenticators(ALLOWED)
          .setConfirmationRequired(false)
          .build()
        prompt.authenticate(BiometricPrompt.CryptoObject(cipher), signal, activity.mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
          override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
            val c = result.cryptoObject?.cipher
            if (c == null) finish(null, FAILED) else finish(c, null)
          }

          override fun onAuthenticationError(code: Int, message: CharSequence) = finish(null, error(code))

          // A finger that did not match: the prompt stays and says so itself.
          override fun onAuthenticationFailed() {}
        })
      } catch (e: Exception) {
        finish(null, FAILED)
      }
    }
  }

  /** A BiometricPrompt error as the client's code. */
  fun error(code: Int): String = when (code) {
    BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED, BiometricPrompt.BIOMETRIC_ERROR_CANCELED,
    BiometricPrompt.BIOMETRIC_ERROR_NEGATIVE_BUTTON, BiometricPrompt.BIOMETRIC_ERROR_TIMEOUT -> CANCELLED
    BiometricPrompt.BIOMETRIC_ERROR_LOCKOUT, BiometricPrompt.BIOMETRIC_ERROR_LOCKOUT_PERMANENT -> LOCKOUT
    BiometricPrompt.BIOMETRIC_ERROR_NO_BIOMETRICS, BiometricPrompt.BIOMETRIC_ERROR_HW_NOT_PRESENT,
    BiometricPrompt.BIOMETRIC_ERROR_HW_UNAVAILABLE, BiometricPrompt.BIOMETRIC_ERROR_NO_DEVICE_CREDENTIAL,
    BiometricPrompt.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED -> UNAVAILABLE
    else -> FAILED
  }

  /** The keys in the Android Keystore. */
  @RequiresApi(30)
  private object KeystoreKeys : UnlockVault.Keys {
    private fun store() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    override fun create(alias: String): SecretKey {
      return try {
        generate(alias, strongBox = Build.VERSION.SDK_INT >= 28)
      } catch (e: StrongBoxUnavailableException) {
        generate(alias, strongBox = false)
      }
    }

    private fun generate(alias: String, strongBox: Boolean): SecretKey {
      val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .setUserAuthenticationRequired(true)
        .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
        .setInvalidatedByBiometricEnrollment(true)
        .setIsStrongBoxBacked(strongBox)
        .build()
      return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply { init(spec) }.generateKey()
    }

    override fun get(alias: String): SecretKey? = try {
      store().getKey(alias, null) as? SecretKey
    } catch (e: Exception) {
      null
    }

    override fun delete(alias: String) {
      try {
        store().deleteEntry(alias)
      } catch (e: Exception) {
        // Nothing stored.
      }
    }
  }
}
