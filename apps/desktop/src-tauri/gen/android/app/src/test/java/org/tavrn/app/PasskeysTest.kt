// SPDX-License-Identifier: Apache-2.0
package org.tavrn.app

import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialUnknownException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.NoCredentialException
import org.junit.Assert.assertEquals
import org.junit.Test

/** The Credential Manager's errors as the client's codes, which it shows as a browser's WebAuthn errors. */
class PasskeysTest {
  @Test
  fun domErrorsBecomeTheBrowsersErrors() {
    assertEquals(Passkeys.EXISTS, Passkeys.dom("androidx.credentials.TYPE_INVALID_STATE_ERROR"))
    assertEquals(Passkeys.CANCELLED, Passkeys.dom("androidx.credentials.TYPE_NOT_ALLOWED_ERROR"))
    assertEquals(Passkeys.CANCELLED, Passkeys.dom("androidx.credentials.TYPE_ABORT_ERROR"))
    assertEquals(Passkeys.REFUSED, Passkeys.dom("androidx.credentials.TYPE_SECURITY_ERROR"))
    assertEquals(Passkeys.UNAVAILABLE, Passkeys.dom("androidx.credentials.TYPE_NOT_SUPPORTED_ERROR"))
    assertEquals(Passkeys.FAILED, Passkeys.dom("androidx.credentials.TYPE_UNKNOWN_ERROR"))
  }

  @Test
  fun cancellingOrHavingNoPasskeyIsACancel() {
    assertEquals(Passkeys.CANCELLED, Passkeys.code(CreateCredentialCancellationException()))
    assertEquals(Passkeys.CANCELLED, Passkeys.code(GetCredentialCancellationException()))
    assertEquals(Passkeys.CANCELLED, Passkeys.code(NoCredentialException()))
    assertEquals(Passkeys.FAILED, Passkeys.code(CreateCredentialUnknownException()))
    assertEquals(Passkeys.FAILED, Passkeys.code(IllegalStateException("x")))
  }
}
