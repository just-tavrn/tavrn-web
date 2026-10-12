// SPDX-License-Identifier: Apache-2.0
package org.tavrn.app

import java.nio.file.Files as NioFiles
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The wrapping of the biometric unlock (`UnlockVault`, docs/ANDROID.md "Unlock with fingerprint, face or PIN"), with
 * software AES keys in place of the Android Keystore's; the prompt that authenticates the cipher is the only part the
 * JVM cannot run (the emulator check covers it).
 */
class UnlockVaultTest {
  private val alice = "unlock/https://tavrn.example/alice@tavrn.example"
  private val bob = "unlock/https://tavrn.example/bob@tavrn.example"
  private val secret = ByteArray(32) { (it + 1).toByte() }

  /** Software keys; `shared` hands every alias the same key (to test the binding to the entry alone). */
  private class FakeKeys(private val shared: Boolean = false) : UnlockVault.Keys {
    val keys = HashMap<String, SecretKey>()
    private val one: SecretKey by lazy { generate() }
    var created = 0

    private fun generate(): SecretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

    override fun create(alias: String): SecretKey {
      created++
      return (if (shared) one else generate()).also { keys[alias] = it }
    }

    override fun get(alias: String): SecretKey? = keys[alias]

    override fun delete(alias: String) {
      keys.remove(alias)
    }

    /** What Android does after a new fingerprint: the key exists, but the cipher refuses it. */
    fun invalidate(alias: String) {
      keys[alias] = SecretKeySpec(ByteArray(7), "AES")
    }
  }

  private class MemoryFiles : UnlockVault.Files {
    val files = HashMap<String, ByteArray>()
    override fun read(name: String) = files[name]?.copyOf()
    override fun write(name: String, bytes: ByteArray) {
      files[name] = bytes.copyOf()
    }
    override fun delete(name: String) {
      files.remove(name)
    }
  }

  private fun store(vault: UnlockVault, entry: String, value: ByteArray = secret) {
    val cipher = vault.beginStore(entry)
    // Here the app shows the prompt with the cipher; a software key needs none.
    vault.finishStore(entry, cipher, value)
  }

  private fun open(vault: UnlockVault, entry: String): ByteArray = vault.finishGet(entry, vault.beginGet(entry))

  @Test
  fun aStoredSecretOpensAgain() {
    val keys = FakeKeys()
    val files = MemoryFiles()
    val vault = UnlockVault(keys, files)
    assertEquals(UnlockVault.Stored.NONE, vault.stored(alice))
    store(vault, alice)
    assertEquals(UnlockVault.Stored.READY, vault.stored(alice))
    assertArrayEquals(secret, open(vault, alice))
    // The blob holds only ciphertext: version, IV, the sealed secret and the tag.
    val blob = files.files.getValue(UnlockVault.file(alice))
    assertEquals(1 + 12 + 32 + 16, blob.size)
    assertTrue("no plaintext in the blob", blob.toList().windowed(32).none { it == secret.toList() })
  }

  @Test
  fun nothingStoredIsMissingNotInvalidated() {
    val vault = UnlockVault(FakeKeys(), MemoryFiles())
    assertThrows(UnlockVault.Missing::class.java) { vault.beginGet(alice) }
  }

  @Test
  fun entriesAreApartEvenUnderOneKey() {
    val files = MemoryFiles()
    val vault = UnlockVault(FakeKeys(shared = true), files)
    store(vault, alice)
    store(vault, bob, ByteArray(32) { 9 })
    // Alice's blob under Bob's name: the associated data names the entry, so it does not open (and is wiped).
    files.files[UnlockVault.file(bob)] = files.files.getValue(UnlockVault.file(alice))
    assertThrows(UnlockVault.Invalidated::class.java) { open(vault, bob) }
    assertNull(files.files[UnlockVault.file(bob)])
    assertArrayEquals(secret, open(vault, alice))
  }

  @Test
  fun anInvalidatedKeyWipesTheEntry() {
    val keys = FakeKeys()
    val files = MemoryFiles()
    val vault = UnlockVault(keys, files)
    store(vault, alice)
    store(vault, bob)
    keys.invalidate(UnlockVault.alias(alice))
    assertEquals(UnlockVault.Stored.INVALIDATED, vault.stored(alice))
    assertNull("the blob is wiped", files.files[UnlockVault.file(alice)])
    assertNull("the key is deleted", keys.keys[UnlockVault.alias(alice)])
    assertEquals(UnlockVault.Stored.NONE, vault.stored(alice))
    assertArrayEquals("other entries stay", secret, open(vault, bob))
  }

  @Test
  fun aDeletedKeyIsInvalidatedToo() {
    // Removing the screen lock deletes the keystore's keys that need it.
    val keys = FakeKeys()
    val files = MemoryFiles()
    val vault = UnlockVault(keys, files)
    store(vault, alice)
    keys.keys.clear()
    assertThrows(UnlockVault.Invalidated::class.java) { vault.beginGet(alice) }
    assertNull(files.files[UnlockVault.file(alice)])
  }

  @Test
  fun aChangedBlobDoesNotOpen() {
    val files = MemoryFiles()
    val vault = UnlockVault(FakeKeys(), files)
    for (at in listOf(0, 1, 20, 60)) {
      store(vault, alice)
      val blob = files.files.getValue(UnlockVault.file(alice))
      blob[at] = (blob[at].toInt() xor 1).toByte()
      files.files[UnlockVault.file(alice)] = blob
      assertThrows("byte $at", UnlockVault.Invalidated::class.java) { open(vault, alice) }
      assertNull(files.files[UnlockVault.file(alice)])
    }
    files.files[UnlockVault.file(alice)] = ByteArray(10)
    assertThrows(UnlockVault.Invalidated::class.java) { vault.beginGet(alice) }
  }

  @Test
  fun storingAgainMakesAFreshKey() {
    val keys = FakeKeys()
    val files = MemoryFiles()
    val vault = UnlockVault(keys, files)
    store(vault, alice)
    val first = keys.keys.getValue(UnlockVault.alias(alice))
    store(vault, alice, ByteArray(32) { 5 })
    assertEquals(2, keys.created)
    assertTrue(first !== keys.keys.getValue(UnlockVault.alias(alice)))
    assertArrayEquals(ByteArray(32) { 5 }, open(vault, alice))
  }

  @Test
  fun aCancelledStoreLeavesNothingBehind() {
    // beginStore wipes the old entry first: a prompt the user cancels leaves the entry empty, never half written.
    val keys = FakeKeys()
    val files = MemoryFiles()
    val vault = UnlockVault(keys, files)
    store(vault, alice)
    vault.beginStore(alice)
    vault.clear(alice)
    assertEquals(UnlockVault.Stored.NONE, vault.stored(alice))
    assertTrue(keys.keys.isEmpty() && files.files.isEmpty())
  }

  @Test
  fun onlyKeysOf32BytesAreStored() {
    val vault = UnlockVault(FakeKeys(), MemoryFiles())
    for (size in listOf(0, 16, 31, 33)) {
      val cipher = vault.beginStore(alice)
      assertThrows(IllegalArgumentException::class.java) { vault.finishStore(alice, cipher, ByteArray(size)) }
    }
  }

  @Test
  fun clearRemovesBlobAndKey() {
    val keys = FakeKeys()
    val files = MemoryFiles()
    val vault = UnlockVault(keys, files)
    store(vault, alice)
    vault.clear(alice)
    vault.clear(alice)
    assertTrue(keys.keys.isEmpty() && files.files.isEmpty())
  }

  @Test
  fun namesAreHashesOfTheEntry() {
    val id = UnlockVault.id(alice)
    assertEquals(64, id.length)
    assertTrue(id.all { it in '0'..'9' || it in 'a'..'f' })
    assertTrue(UnlockVault.id(bob) != id)
    assertEquals("org.tavrn.app.unlock.$id", UnlockVault.alias(alice))
    assertEquals("$id.bin", UnlockVault.file(alice))
    for (bad in listOf("", "alice@tavrn.example", "keys/x", "unlock/" + "x".repeat(UnlockVault.MAX_ENTRY))) {
      assertThrows(bad, IllegalArgumentException::class.java) { UnlockVault.id(bad) }
    }
  }

  @Test
  fun theBlobFormat() {
    val iv = ByteArray(12) { 1 }
    val sealed = ByteArray(48) { 2 }
    val blob = UnlockVault.encode(iv, sealed)
    assertEquals(UnlockVault.VERSION, blob[0])
    val (backIv, backSealed) = UnlockVault.decode(blob)!!
    assertArrayEquals(iv, backIv)
    assertArrayEquals(sealed, backSealed)
    assertNull(UnlockVault.decode(byteArrayOf(2) + iv + sealed))
    assertNull(UnlockVault.decode(blob.copyOf(blob.size - 1)))
    assertThrows(IllegalArgumentException::class.java) { UnlockVault.encode(ByteArray(16), sealed) }
  }

  @Test
  fun theBlobsLiveInTheirDirectory() {
    val dir = NioFiles.createTempDirectory("unlock").toFile()
    try {
      val files = UnlockVault.DirFiles(java.io.File(dir, "unlock"))
      assertNull(files.read("a.bin"))
      files.write("a.bin", byteArrayOf(1, 2, 3))
      files.write("a.bin", byteArrayOf(4))
      assertArrayEquals(byteArrayOf(4), files.read("a.bin"))
      assertEquals(listOf("a.bin"), java.io.File(dir, "unlock").list()!!.toList())
      files.delete("a.bin")
      assertNull(files.read("a.bin"))
    } finally {
      dir.deleteRecursively()
    }
  }
}
