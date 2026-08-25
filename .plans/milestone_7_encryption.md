# Milestone 7 — Encryption & Key Management

## Overview

Add end-to-end authenticated encryption to all application messages. Keys are derived through a secure pairing process (QR code or numeric code) — never hardcoded. All messages are encrypted with AES-256-GCM before transmission.

```
Text
  ↓ UTF-8 encode
  ↓ zstd compress
  ↓ AES-256-GCM encrypt (with 12-byte nonce, 16-byte auth tag)
  ↓ [nonce (12)] + [ciphertext] + [auth tag (16)]
  ↓ Binary packet payload
  ↓ BLE/Wi-Fi
```

---

## Cryptographic Design

### Algorithm

**AES-256-GCM** (AEAD — Authenticated Encryption with Associated Data)

- Key: 256-bit (32 bytes)
- Nonce: 96-bit (12 bytes), random per message
- Auth tag: 128-bit (16 bytes)
- Authenticated data: packet header bytes (binds encryption to metadata)

AES-256-GCM overhead per message: **28 bytes** (12 nonce + 16 tag).

### Key Exchange: ECDH over Curve25519

```
Device A                              Device B
─────────────────────────────────────────────────────
Generate ephemeral keypair            Generate ephemeral keypair
(publicA, privateA)                   (publicB, privateB)
         │                                     │
         └──── share publicA ────────────────▶ │
         │                                     │
         │ ◀─────────────── share publicB ─────┘
         │                                     │
sharedSecret = ECDH(privateA, publicB) = ECDH(privateB, publicA)
         │                                     │
sessionKey = HKDF-SHA256(sharedSecret, salt="iTantra-v1", info=deviceIds)
```

**Public key sharing** is done via:
1. **QR Code** (primary): Device B displays QR → Device A scans → exchange complete
2. **Numeric PIN** (fallback): 6-digit verification code confirmed out-of-band

---

## Proposed Changes

### Kotlin

#### [NEW] `android/app/src/main/java/com/itantra/crypto/KeyPairManager.kt`
```kotlin
object KeyPairManager {
    // Generate ephemeral X25519 keypair using Android BouncyCastle / Conscrypt
    fun generateEphemeralKeyPair(): KeyPair  // X25519
    fun deriveSharedSecret(ourPrivateKey: PrivateKey, theirPublicKey: PublicKey): ByteArray
    fun deriveSessionKey(sharedSecret: ByteArray, localId: String, remoteId: String): ByteArray
    // HKDF-SHA256 derivation
}
```
- Uses `javax.crypto` + `java.security` (Android Conscrypt provider)
- X25519 via `KeyAgreement.getInstance("X25519")`
- HKDF via `Mac.getInstance("HmacSHA256")`

#### [NEW] `android/app/src/main/java/com/itantra/crypto/AESGCMCipher.kt`
```kotlin
object AESGCMCipher {
    const val NONCE_SIZE = 12
    const val TAG_SIZE   = 16

    fun encrypt(
        plaintext: ByteArray,
        key: ByteArray,            // 32 bytes
        associatedData: ByteArray  // packet header bytes
    ): EncryptedPayload

    fun decrypt(
        ciphertext: ByteArray,     // includes nonce prefix + tag suffix
        key: ByteArray,
        associatedData: ByteArray
    ): ByteArray?  // null = authentication failure

    data class EncryptedPayload(
        val nonce: ByteArray,      // 12 bytes
        val ciphertext: ByteArray, // encrypted content
        val tag: ByteArray         // 16 bytes (GCM tag, may be appended by JCE)
    ) {
        fun toBytes(): ByteArray   // nonce + ciphertext (tag included by JCE)
    }
}
```
- Uses `Cipher.getInstance("AES/GCM/NoPadding")`
- Random nonce via `SecureRandom` per message
- Auth failure → return null (caller sends NACK)

#### [NEW] `android/app/src/main/java/com/itantra/crypto/SessionKeyStore.kt`
```kotlin
class SessionKeyStore(context: Context) {
    // Stores derived session keys per peer device
    // Uses Android Keystore for long-term key storage
    fun storeSessionKey(peerId: String, key: ByteArray)
    fun getSessionKey(peerId: String): ByteArray?
    fun removeSessionKey(peerId: String)
    fun clearAll()
}
```
- In-memory for session duration
- Optional: Android Keystore for persisted paired devices
- **Never stores raw keys in SharedPreferences**
- Keys are associated with device ID, not user identity

#### [NEW] `android/app/src/main/java/com/itantra/crypto/PairingManager.kt`
```kotlin
class PairingManager(
    private val keyPairManager: KeyPairManager,
    private val sessionKeyStore: SessionKeyStore,
    private val bleModule: BLEConnectionManager
) {
    fun generatePairingData(): PairingData
    fun completePairing(theirPublicKeyBytes: ByteArray, peerId: String)
    fun isPaired(peerId: String): Boolean
    fun unpair(peerId: String)

    data class PairingData(
        val publicKeyBytes: ByteArray,  // our ephemeral X25519 public key
        val deviceId: String,
        val qrPayload: String           // JSON: { "pk": base64, "id": deviceId }
    )
}
```

#### [MODIFY] `android/app/src/main/java/com/itantra/protocol/PacketCodec.kt` (update)
```kotlin
class PacketCodec(private val cryptoManager: CryptoManager) {
    fun encode(text: String, type: Byte, language: Byte, peerId: String): ByteArray {
        val utf8 = text.toByteArray(Charsets.UTF_8)
        val compressed = CompressManager.compress(utf8)
        val sessionKey = sessionKeyStore.getSessionKey(peerId)
        val header = PacketBuilder.buildHeaderBytes(...)
        val encrypted = AESGCMCipher.encrypt(compressed, sessionKey, associatedData = header)
        return header + encrypted.toBytes()
    }

    fun decode(rawPacket: ByteArray, peerId: String): DecodeResult {
        val packet = PacketParser.parse(rawPacket)
        val sessionKey = sessionKeyStore.getSessionKey(peerId)
        val decrypted = AESGCMCipher.decrypt(packet.payload, sessionKey,
                                              associatedData = packet.headerBytes)
            ?: return DecodeResult.AuthFailure
        val decompressed = CompressManager.decompress(decrypted)
        return DecodeResult.Success(decompressed.toString(Charsets.UTF_8), packet)
    }
}
```

---

### Pairing UI

#### [NEW] `src/screens/PairingScreen.js`
Two-step pairing flow:

**Step 1 — Initiate** (Device A shows QR):
```
┌──────────────────────────────┐
│  Pair with this device       │
│                              │
│  [QR Code containing         │
│   public key + device ID]    │
│                              │
│  OR enter code: 847-291      │
└──────────────────────────────┘
```

**Step 2 — Scan** (Device B scans QR):
```
┌──────────────────────────────┐
│  Scan partner's QR code      │
│  [Camera viewfinder]         │
│                              │
│  OR enter 6-digit code       │
└──────────────────────────────┘
```

**Step 3 — Confirm**:
```
Both devices show same 6-digit confirmation code.
[CONFIRM]  [CANCEL]
```

Libraries:
- QR display: `react-native-qrcode-svg`
- QR scan: `react-native-camera` or `react-native-vision-camera` (offline, no cloud)

#### [MODIFY] `src/screens/ConnectScreen.js`
- After BLE connect → prompt pairing if not already paired
- Show padlock icon: 🔒 paired, 🔓 not paired

---

### Compression (Integrated here)

#### [NEW] `android/app/src/main/java/com/itantra/compression/CompressManager.kt`
```kotlin
object CompressManager {
    // zstd compression (fast, good ratio for short text)
    fun compress(data: ByteArray): ByteArray
    fun decompress(data: ByteArray): ByteArray
    fun compressionRatio(original: ByteArray, compressed: ByteArray): Float

    // Note: for short text (< 20 bytes), may skip compression if ratio > 1.0
    fun shouldCompress(data: ByteArray): Boolean = data.size > 20
}
```
Dependency: `com.github.luben:zstd-jni:1.5.5-11` (Android ABI support)

Pipeline correctness:
```
✅ encrypt(compress(data))
❌ compress(encrypt(data))
```

---

## Security Testing

#### [NEW] `android/app/src/test/java/com/itantra/crypto/AESGCMTest.kt`
```kotlin
@Test fun `encrypt-decrypt round-trip succeeds`() { ... }
@Test fun `modified ciphertext fails authentication`() { ... }
@Test fun `modified associated data fails authentication`() { ... }
@Test fun `replay with same nonce detected`() { ... }
@Test fun `wrong key returns null`() { ... }
@Test fun `ECDH produces same shared secret on both sides`() { ... }
```

---

## Verification Plan

### Automated
```bash
./gradlew :app:testDebugUnitTest --tests "com.itantra.crypto.*"
./gradlew :app:testDebugUnitTest --tests "com.itantra.compression.*"
```

### Manual
1. Pair Device A and B via QR code
2. Send message → arrives decrypted on B
3. Use BLE sniffer → confirm payload is opaque binary (not readable text)
4. Modify a byte in captured packet → NACK sent, "DECRYPTION_FAILED" shown
5. Send from unpaired device → rejected, NACK returned
6. Confirm no keys in logcat output
7. Confirm airplane mode → encryption still works

### Security Properties

| Property | Mechanism |
|---|---|
| Confidentiality | AES-256-GCM encryption |
| Integrity | GCM authentication tag |
| Authenticity | ECDH key exchange, only paired devices have session key |
| Forward secrecy | Ephemeral X25519 keypairs (new key per pairing session) |
| Replay protection | Nonce uniqueness + sequence numbers (Milestone 8) |
| Key storage | Android Keystore (hardware-backed where available) |
