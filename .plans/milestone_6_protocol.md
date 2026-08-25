# Milestone 6 — Binary Protocol

## Overview

Replace ad-hoc text transmission with a compact binary protocol. Every message becomes a structured binary packet with versioning, message type, language code, sequence number, sender/receiver IDs, and encrypted payload.

This milestone delivers the message layer that sits on top of the BLE transport.

---

## Packet Format

### Header (Fixed 24 bytes)

```
Byte  0      : Version (1 byte)          - Protocol version, currently 0x01
Byte  1      : Type (1 byte)             - Message type (see below)
Byte  2      : Language (1 byte)         - Language code (see below)
Byte  3      : Priority (1 byte)         - 0=NORMAL, 1=IMPORTANT, 2=ALERT
Bytes 4–7    : Message ID (4 bytes)      - Unique uint32 per message
Bytes 8–11   : Sequence (4 bytes)        - Sequence number uint32
Bytes 12–15  : Sender ID (4 bytes)       - First 4 bytes of device ID hash
Bytes 16–19  : Destination ID (4 bytes)  - First 4 bytes of dest device ID hash
Bytes 20–21  : Payload Length (2 bytes)  - uint16, max 65535
Byte  22     : Fragment Index (1 byte)   - 0-indexed fragment number
Byte  23     : Total Fragments (1 byte)  - Total fragment count for this message
```

### Payload (variable, max 65535 bytes when reassembled)

For non-fragmented messages (single BLE packet):
```
[24-byte header][compressed+encrypted payload]
```

For fragmented messages:
```
Fragment 0: [24-byte header (frag=0, total=N)][payload chunk 0]
Fragment 1: [24-byte header (frag=1, total=N)][payload chunk 1]
...
Fragment N: [24-byte header (frag=N, total=N)][payload chunk N]
```

### Message Types (Byte 1)

```kotlin
object MessageType {
    const val NORMAL    : Byte = 0x01
    const val IMPORTANT : Byte = 0x02
    const val ALERT     : Byte = 0x03
    const val ACK       : Byte = 0x10
    const val NACK      : Byte = 0x11
    const val SYSTEM    : Byte = 0x20
    const val PING      : Byte = 0x21
    const val PONG      : Byte = 0x22
    const val ERROR     : Byte = 0xFF.toByte()
}
```

### Language Codes (Byte 2)

```kotlin
object LanguageCode {
    const val ENGLISH   : Byte = 0x01
    const val HINDI     : Byte = 0x02
    const val BENGALI   : Byte = 0x03
    const val GUJARATI  : Byte = 0x04
    const val MARATHI   : Byte = 0x05
    const val KANNADA   : Byte = 0x06
    const val MALAYALAM : Byte = 0x07
    const val TAMIL     : Byte = 0x08
    const val TELUGU    : Byte = 0x09
    const val ODIA      : Byte = 0x0A
}
```

---

## ACK Packet Format

```
[Version=0x01][Type=ACK][Lang=0x00][Priority=0x00]
[ACK'd Message ID (4 bytes)]
[ACK'd Sequence (4 bytes)]
[Sender ID (4 bytes)]
[Dest ID (4 bytes)]
[Payload Len = 0 (2 bytes)]
[Frag=0][Total=1]
```

## NACK Packet Format

Same as ACK but `Type=NACK`, with payload = 1-byte error code:
```kotlin
object NACKReason {
    const val DECRYPTION_FAILED : Byte = 0x01
    const val INVALID_VERSION   : Byte = 0x02
    const val UNKNOWN_SENDER    : Byte = 0x03
    const val MESSAGE_EXPIRED   : Byte = 0x04
    const val DUPLICATE         : Byte = 0x05
    const val CHECKSUM_FAIL     : Byte = 0x06
}
```

---

## Proposed Changes

### Kotlin

#### [NEW] `android/app/src/main/java/com/itantra/protocol/Packet.kt`
```kotlin
data class Packet(
    val version: Byte = 0x01,
    val type: Byte,
    val language: Byte,
    val priority: Byte,
    val messageId: UInt,
    val sequence: UInt,
    val senderId: UInt,
    val destinationId: UInt,
    val fragmentIndex: Byte,
    val totalFragments: Byte,
    val payload: ByteArray
)
```

#### [NEW] `android/app/src/main/java/com/itantra/protocol/PacketBuilder.kt`
```kotlin
object PacketBuilder {
    fun build(packet: Packet): ByteArray
    fun buildAck(messageId: UInt, sequence: UInt, senderId: UInt, destId: UInt): ByteArray
    fun buildNack(messageId: UInt, reason: Byte, senderId: UInt, destId: UInt): ByteArray
    fun buildPing(senderId: UInt): ByteArray
}
```
- Uses `ByteBuffer` with `ByteOrder.BIG_ENDIAN`
- Header always 24 bytes
- Payload appended directly

#### [NEW] `android/app/src/main/java/com/itantra/protocol/PacketParser.kt`
```kotlin
object PacketParser {
    fun parse(data: ByteArray): ParseResult

    sealed class ParseResult {
        data class Success(val packet: Packet) : ParseResult()
        data class Failure(val error: ParseError) : ParseResult()
    }

    enum class ParseError {
        TOO_SHORT, INVALID_VERSION, INVALID_TYPE, INVALID_LANGUAGE,
        PAYLOAD_LENGTH_MISMATCH, CHECKSUM_FAIL
    }
}
```
- Validates minimum length (24 bytes)
- Validates version byte
- Validates payload length matches declared length

#### [NEW] `android/app/src/main/java/com/itantra/protocol/SequenceManager.kt`
```kotlin
class SequenceManager {
    fun nextSequence(): UInt               // atomically incrementing counter
    fun generateMessageId(): UInt          // random uint32
    fun isDuplicate(msgId: UInt): Boolean  // check seen message IDs (LRU cache, last 256)
    fun markSeen(msgId: UInt)
}
```

#### [NEW] `android/app/src/main/java/com/itantra/protocol/MessageReassembler.kt`
```kotlin
class MessageReassembler {
    fun addFragment(packet: Packet): ReassemblyResult

    sealed class ReassemblyResult {
        object Incomplete : ReassemblyResult()
        data class Complete(val payload: ByteArray, val firstPacket: Packet) : ReassemblyResult()
        data class Error(val reason: String) : ReassemblyResult()
    }
}
```
- Holds partial fragments per `messageId`
- On complete set: reassembles in fragment-index order
- Drops incomplete messages after TTL (30 seconds)

#### [MODIFY] `android/app/src/main/java/com/itantra/transport/TransportManager.kt`
```kotlin
class TransportManager(
    private val ble: BLEConnectionManager
) {
    fun send(packet: Packet)
    fun onRawData(data: ByteArray, fromDevice: String)  // → PacketParser → dispatch
    var onPacketReceived: ((Packet) -> Unit)? = null
    var onAckReceived: ((UInt) -> Unit)? = null        // message ID acknowledged
    var onNackReceived: ((UInt, Byte) -> Unit)? = null
}
```
- Receives raw BLE bytes → parses → dispatches
- Sends ACK automatically on `NORMAL`/`IMPORTANT`/`ALERT`
- Queues outgoing packets with retry logic stub (full retry in Milestone 8)

---

### JS Layer

#### [MODIFY] `src/protocol/PacketBuilder.js`
JS-side packet construction for protocol validation testing:
```javascript
export function buildPacket({ type, language, priority, messageId, sequence,
                               senderId, destinationId, payload }) {
  const header = new ArrayBuffer(24);
  const view = new DataView(header);
  // ... fill header fields ...
  return Buffer.concat([Buffer.from(header), payload]);
}
```

#### [MODIFY] `src/protocol/PacketParser.js`
```javascript
export function parsePacket(buffer) {
  if (buffer.length < 24) return { error: 'TOO_SHORT' };
  // ... parse header fields ...
  return { header, payload: buffer.slice(24) };
}
```

#### [MODIFY] `src/protocol/MessageTypes.js`
```javascript
export const MessageType = {
  NORMAL: 0x01, IMPORTANT: 0x02, ALERT: 0x03,
  ACK: 0x10, NACK: 0x11, SYSTEM: 0x20, PING: 0x21, PONG: 0x22, ERROR: 0xFF
};

export const LanguageCode = {
  en: 0x01, hi: 0x02, bn: 0x03, gu: 0x04, mr: 0x05,
  kn: 0x06, ml: 0x07, ta: 0x08, te: 0x09, or: 0x0A
};
```

#### [MODIFY] `src/services/CommunicationService.js`
Updated flow:
```
sendMessage(text, language, type) {
  1. Encode text as UTF-8 bytes
  2. Build Packet (type, language, priority derived from type)
  3. NativeBLE.send(base64(packetBytes))
  4. Start ACK timer (3 seconds)
  5. On BLE_DATA_RECEIVED → parsePacket → handle ACK/NACK/message
}
```

---

## Unit Tests

#### [NEW] `tests/protocol/PacketBuilder.test.js`
```javascript
test('builds 24-byte header correctly', () => { ... });
test('parses back to original fields', () => { ... });
test('detects TOO_SHORT packet', () => { ... });
test('detects INVALID_VERSION', () => { ... });
test('ACK packet correct type byte', () => { ... });
```

#### [NEW] `android/app/src/test/java/com/itantra/protocol/PacketTest.kt`
```kotlin
@Test fun `build and parse round-trip`() { ... }
@Test fun `ACK packet correct format`() { ... }
@Test fun `NACK with reason byte`() { ... }
@Test fun `too-short packet returns ParseError`() { ... }
```

---

## Verification Plan

### Automated
```bash
npm test -- --testPathPattern=protocol
./gradlew :app:testDebugUnitTest --tests "com.itantra.protocol.*"
```

### Manual
1. Send text message Phone A → B using new protocol
2. Wireshark/BLE sniffer: confirm 24-byte header + payload (not plain JSON)
3. Confirm ACK received on A after B receives message
4. Modify a byte in transit manually → NACK returned
5. BenchmarkScreen shows "Payload: XX bytes" (compact binary)

### Payload Size Targets

| Message | Raw UTF-8 | Binary Packet |
|---|---|---|
| "Help" (4 chars) | 4 bytes | 28 bytes |
| "Send medical help to sector 4" (30 chars) | 30 bytes | 54 bytes |
| "Evacuate shelter three immediately." (36 chars) | 36 bytes | 60 bytes |
