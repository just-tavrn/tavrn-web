// SPDX-License-Identifier: Apache-2.0
package org.tavrn.app

import java.io.File
import java.security.GeneralSecurityException
import java.security.InvalidKeyException
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The wrapping of the biometric unlock (docs/ANDROID.md "Unlock with fingerprint, face or PIN"), without anything of
 * Android, so the JVM unit tests run it with a software key: the client's local storage key (32 bytes, the secret
 * that opens the local key store) is sealed with AES-256-GCM under a key of the Android Keystore that works only right
 * after the user authenticated ([BiometricUnlock] makes it and shows the prompt). The sealed blob lives in the app's
 * private storage, one per entry (`unlock/<home node>/<account>`, built and checked by the Rust side), bound to its
 * entry by the GCM associated data, so a blob copied to another entry does not open.
 *
 * Every operation is in two steps: `begin…` prepares the cipher (it fails without a prompt when the key is gone or
 * invalidated), the prompt authenticates it, `finish…` uses it.
 */
class UnlockVault(private val keys: Keys, private val files: Files) {
  /** The keystore keys, by alias. */
  interface Keys {
    /** A new key for `alias` (an existing one is replaced). */
    fun create(alias: String): SecretKey
    fun get(alias: String): SecretKey?
    fun delete(alias: String)
  }

  /** The blobs, by file name. */
  interface Files {
    fun read(name: String): ByteArray?
    fun write(name: String, bytes: ByteArray)
    fun delete(name: String)
  }

  /** What is stored for an entry. */
  enum class Stored(val code: String) { READY("ready"), NONE("none"), INVALIDATED("invalidated") }

  /** The entry's key is gone or permanently invalidated (new biometrics, the screen lock removed): it was wiped. */
  class Invalidated : Exception("unlock.invalidated")

  /** Nothing is stored for the entry. */
  class Missing : Exception("unlock.none")

  /** A blob to open: the cipher (to authenticate) and the sealed secret. */
  class Opening(val cipher: Cipher, val sealed: ByteArray)

  /** Whether the entry can be opened (a prompt would work); an invalidated entry is wiped. Never prompts. */
  fun stored(entry: String): Stored = try {
    beginGet(entry)
    Stored.READY
  } catch (e: Missing) {
    Stored.NONE
  } catch (e: Invalidated) {
    Stored.INVALIDATED
  }

  /** A fresh key for the entry (the old key and blob are wiped) and its cipher, to seal after the prompt. */
  fun beginStore(entry: String): Cipher {
    clear(entry)
    val key = keys.create(alias(entry))
    return try {
      Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key) }
    } catch (e: GeneralSecurityException) {
      keys.delete(alias(entry))
      throw e
    }
  }

  /** Seals `secret` with the authenticated cipher of [beginStore] and writes the blob. */
  fun finishStore(entry: String, cipher: Cipher, secret: ByteArray) {
    require(secret.size == SECRET_LEN) { "unlock.invalid" }
    cipher.updateAAD(aad(entry))
    val sealed = cipher.doFinal(secret)
    files.write(file(entry), encode(cipher.iv, sealed))
  }

  /** The cipher that opens the entry's blob after the prompt; throws [Missing] or [Invalidated] (then wiped). */
  fun beginGet(entry: String): Opening {
    val blob = files.read(file(entry)) ?: throw Missing()
    val parts = decode(blob)
    val key = keys.get(alias(entry))
    if (parts == null || key == null) {
      clear(entry)
      throw Invalidated()
    }
    val cipher = Cipher.getInstance(TRANSFORMATION)
    try {
      cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, parts.first))
    } catch (e: InvalidKeyException) {
      // KeyPermanentlyInvalidatedException: new biometrics were enrolled or the screen lock was removed.
      clear(entry)
      throw Invalidated()
    }
    return Opening(cipher, parts.second)
  }

  /** The secret, opened with the authenticated cipher of [beginGet]; a blob that does not open is wiped. */
  fun finishGet(entry: String, opening: Opening): ByteArray {
    val secret = try {
      opening.cipher.updateAAD(aad(entry))
      opening.cipher.doFinal(opening.sealed)
    } catch (e: javax.crypto.AEADBadTagException) {
      clear(entry)
      throw Invalidated()
    }
    if (secret.size != SECRET_LEN) {
      secret.fill(0)
      clear(entry)
      throw Invalidated()
    }
    return secret
  }

  /** Removes the entry's blob and key (turned off, sign-out, invalidated); nothing stored is fine. */
  fun clear(entry: String) {
    files.delete(file(entry))
    keys.delete(alias(entry))
  }

  companion object {
    const val SECRET_LEN = 32
    const val IV_LEN = 12
    const val TAG_BITS = 128
    const val VERSION: Byte = 1
    const val TRANSFORMATION = "AES/GCM/NoPadding"
    const val ALIAS_PREFIX = "org.tavrn.app.unlock."
    /** The longest entry the Rust side builds (`unlock/` + a node origin + an account address) has room to spare. */
    const val MAX_ENTRY = 1024

    /** The hex SHA-256 of the entry: names the file and the key without putting addresses into file names. */
    fun id(entry: String): String {
      require(entry.isNotEmpty() && entry.length <= MAX_ENTRY && entry.startsWith("unlock/")) { "unlock.invalid" }
      return MessageDigest.getInstance("SHA-256").digest(entry.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }

    fun alias(entry: String) = ALIAS_PREFIX + id(entry)
    fun file(entry: String) = id(entry) + ".bin"

    /** The GCM associated data: binds a blob to its entry and to this format. */
    fun aad(entry: String): ByteArray = "tavrn-unlock-v1\u0000$entry".toByteArray(Charsets.UTF_8)

    /** `version | iv | ciphertext and tag`. */
    fun encode(iv: ByteArray, sealed: ByteArray): ByteArray {
      require(iv.size == IV_LEN && sealed.size == SECRET_LEN + TAG_BITS / 8) { "unlock.invalid" }
      return byteArrayOf(VERSION) + iv + sealed
    }

    /** The IV and the sealed secret of a blob, or null when it is not one of this format. */
    fun decode(blob: ByteArray): Pair<ByteArray, ByteArray>? {
      if (blob.size != 1 + IV_LEN + SECRET_LEN + TAG_BITS / 8 || blob[0] != VERSION) return null
      return Pair(blob.copyOfRange(1, 1 + IV_LEN), blob.copyOfRange(1 + IV_LEN, blob.size))
    }
  }

  /** The blobs as files in one private directory (`noBackupFilesDir/unlock`: never in a backup). */
  class DirFiles(private val dir: File) : Files {
    override fun read(name: String): ByteArray? = File(dir, name).takeIf { it.isFile }?.readBytes()

    override fun write(name: String, bytes: ByteArray) {
      dir.mkdirs()
      val tmp = File(dir, "$name.tmp")
      tmp.writeBytes(bytes)
      if (!tmp.renameTo(File(dir, name))) {
        tmp.delete()
        throw java.io.IOException("unlock.failed")
      }
    }

    override fun delete(name: String) {
      File(dir, name).delete()
    }
  }
}
