// SPDX-License-Identifier: Apache-2.0
package org.tavrn.app

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import java.security.MessageDigest
import java.util.Base64

/**
 * The app's WebAuthn origin (PROTOCOL.md §5a.4, docs/ANDROID.md "Passkeys"): the webview's WebAuthn for the app puts
 * `android:apk-key-hash:<base64url of the SHA-256 of the signing certificate>` into `clientDataJSON`. The client
 * compares it with the node's `webauthn.origins` before it offers passkeys in the app; the same certificate is the
 * one in the relying party's `assetlinks.json`.
 */
object AppOrigin {
  const val PREFIX = "android:apk-key-hash:"

  /** The origin of a signing certificate (its DER bytes). */
  fun of(certificate: ByteArray): String =
    PREFIX + Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(certificate))

  /**
   * The origin of the installed app: its one current signer (`apkContentsSigners`, without past keys of a rotation).
   * Null where Android cannot tell (below API 28) or the app has several signers (the client then uses the browser).
   */
  fun of(context: Context): String? {
    if (Build.VERSION.SDK_INT < 28) return null
    return try {
      val info = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
      val signer = info.signingInfo?.apkContentsSigners?.singleOrNull() ?: return null
      of(signer.toByteArray())
    } catch (e: Exception) {
      null
    }
  }
}
