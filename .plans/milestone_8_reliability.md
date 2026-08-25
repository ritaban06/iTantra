# Milestone 8 — Reliability Layer

## Overview

Make the communication system robust against BLE packet loss, reordering, duplication, and disconnections. This milestone adds retransmission, fragmentation/reassembly, deduplication, TTL, and ordered delivery.

---

## Reliability Components

```
Sender                                    Receiver
──────                                    ────────
send(packet)
  ↓
PendingAckQueue.add(packet, timeout=3s)
  ↓
BLE send
                                          receive(packet)
                                            ↓
                                          dedup check → discard if seen
                                            ↓
                                          TTL check → discard if expired
                                            ↓
                                          reassemble fragments
                                            ↓
                                          send ACK
                                            ↓
                                          deliver to app
  ↓
ACK received → remove from PendingAckQueue
  ↓
(no ACK within timeout) → retransmit (max 3 attempts)
  ↓
(all retransmits failed) → BLE_SEND_FAILED event
```

---

## Proposed Changes

### Kotlin

#### [NEW] `android/app/src/main/java/com/itantra/transport/RetransmissionManager.kt`
```kotlin
class RetransmissionManager(
    private val transport: TransportManager,
    private val scope: CoroutineScope
) {
    // Tracks sent packets awaiting ACK
    private val pendingAcks = ConcurrentHashMap<UInt, PendingPacket>()

    fun trackPacket(packet: Packet, rawBytes: ByteArray)
    fun onAckReceived(messageId: UInt)
    fun onNackReceived(messageId: UInt, reason: Byte)
    fun cancelAll()

    data class PendingPacket(
        val packet: Packet,
        val rawBytes: ByteArray,
        val sentAt: Long,
        var attempts: Int = 0,
        val maxAttempts: Int = 3,
        val timeoutMs: Long = 3000L
    )
}
```

**Retransmission schedule** (exponential backoff):
```
Attempt 1: wait 3s
Attempt 2: wait 6s
Attempt 3: wait 12s
→ SEND_FAILED
```

#### [NEW] `android/app/src/main/java/com/itantra/transport/FragmentationManager.kt`
```kotlin
class FragmentationManager(private val mtu: Int) {

    // Splits a large payload into BLE-MTU-sized fragments
    fun fragment(packet: Packet, rawBytes: ByteArray): List<ByteArray> {
        val maxPayloadPerFragment = mtu - HEADER_SIZE  // 24 bytes header
        // Split rawBytes into chunks, set fragmentIndex and totalFragments
    }

    // Check if fragmentation is needed
    fun needsFragmentation(rawBytes: ByteArray): Boolean = rawBytes.size > mtu

    companion object {
        const val HEADER_SIZE = 24
        const val MIN_MTU = 23
        const val DEFAULT_MTU = 247
    }
}
```

Fragment sending:
- Each fragment sent as a separate BLE write
- Each fragment has same `messageId`, different `fragmentIndex`
- Short delay (10ms) between fragments to avoid BLE congestion

#### [MODIFY] `android/app/src/main/java/com/itantra/protocol/MessageReassembler.kt`
```kotlin
class MessageReassembler {
    private val fragments = ConcurrentHashMap<UInt, FragmentBuffer>()

    fun addFragment(packet: Packet): ReassemblyResult

    // Auto-expire incomplete messages after TTL
    private fun startExpiryTimer(messageId: UInt, ttlMs: Long = 30_000L)
    fun onExpired(messageId: UInt)  // emits MESSAGE_EXPIRED event

    data class FragmentBuffer(
        val totalFragments: Byte,
        val received: MutableMap<Byte, ByteArray> = mutableMapOf(),
        val firstPacket: Packet,
        val createdAt: Long = System.currentTimeMillis()
    )
}
```

#### [NEW] `android/app/src/main/java/com/itantra/transport/DeduplicationFilter.kt`
```kotlin
class DeduplicationFilter(capacity: Int = 256) {
    // LRU cache of recently seen message IDs
    private val seen: LinkedHashMap<UInt, Long> = // LRU capacity 256

    fun isDuplicate(messageId: UInt): Boolean
    fun markSeen(messageId: UInt)
    fun evictExpired(maxAgeMs: Long = 60_000L)  // clean entries older than 60s
}
```

#### [NEW] `android/app/src/main/java/com/itantra/transport/TTLChecker.kt`
```kotlin
object TTLChecker {
    // Each packet header could include a timestamp (packed in sequence field or separate)
    // For MVP: check message age against 60-second global TTL
    fun isExpired(packet: Packet, maxAgeMs: Long = 60_000L): Boolean {
        val ageMs = System.currentTimeMillis() - packet.timestampMs
        return ageMs > maxAgeMs
    }
}
```

#### [NEW] `android/app/src/main/java/com/itantra/transport/OrderedDelivery.kt`
```kotlin
class OrderedDelivery {
    // Per-sender ordered buffer
    private val buffers = ConcurrentHashMap<UInt, SenderBuffer>()

    fun add(packet: Packet)
    fun next(senderId: UInt): Packet?   // returns next in-order packet if available

    data class SenderBuffer(
        val expectedSeq: AtomicLong,
        val buffer: TreeMap<UInt, Packet>
    )
}
```

#### [MODIFY] `android/app/src/main/java/com/itantra/transport/TransportManager.kt`
Integrates all reliability components:
```kotlin
class TransportManager(...) {
    private val retransmission = RetransmissionManager(this, scope)
    private val fragmentation  = FragmentationManager(currentMtu)
    private val dedup          = DeduplicationFilter()
    private val reassembler    = MessageReassembler()
    private val ttlChecker     = TTLChecker
    private val ordered        = OrderedDelivery()

    fun send(packet: Packet) {
        val bytes = PacketCodec.encode(packet)
        if (fragmentation.needsFragmentation(bytes)) {
            fragmentation.fragment(packet, bytes).forEach { frag -> ble.send(frag) }
        } else {
            ble.send(bytes)
        }
        retransmission.trackPacket(packet, bytes)
    }

    fun onRawReceived(data: ByteArray) {
        val packet = PacketParser.parse(data) ?: return sendNack(INVALID_PACKET)
        if (dedup.isDuplicate(packet.messageId)) return  // silently drop
        if (ttlChecker.isExpired(packet)) { sendNack(MESSAGE_EXPIRED); return }
        dedup.markSeen(packet.messageId)

        when (packet.type) {
            ACK  -> retransmission.onAckReceived(packet.messageId)
            NACK -> retransmission.onNackReceived(packet.messageId, packet.payload[0])
            else -> {
                val result = reassembler.addFragment(packet)
                if (result is Complete) {
                    sendAck(packet)
                    deliverMessage(result)
                }
            }
        }
    }
}
```

---

### Packet Timestamp (Minor Protocol Addition)

Add a 4-byte timestamp field to header for TTL:
```
Updated Header (28 bytes):
Bytes 24–27: Timestamp (4 bytes) — Unix timestamp / 1000 (seconds), uint32
```

This is a **non-breaking** extension — the version byte is bumped to `0x02`.

---

### JS Layer

#### [MODIFY] `src/services/CommunicationService.js`
- Show delivery status per message: ✓ Sent, ✓✓ Delivered, ✗ Failed
- Show retry indicator: "Retrying (2/3)..."

#### [MODIFY] `src/components/MessageBubble.js`
```
[Message text]   [✓ ✓] Delivered
[Message text]   [⟳ 2] Retrying
[Message text]   [✗] Failed to deliver
```

#### [MODIFY] `src/screens/BenchmarkScreen.js`
Add reliability metrics:
```
Retransmissions: 2
Packet Loss Rate: 1.2%
Duplicate packets dropped: 3
Fragment reassemblies: 1
```

---

## Unit Tests

#### [NEW] `android/.../transport/RetransmissionTest.kt`
```kotlin
@Test fun `ACK removes packet from pending queue`() { ... }
@Test fun `no ACK triggers retransmit after timeout`() { ... }
@Test fun `max retransmit attempts fires SEND_FAILED`() { ... }
@Test fun `backoff doubles correctly`() { ... }
```

#### [NEW] `android/.../transport/FragmentationTest.kt`
```kotlin
@Test fun `payload larger than MTU is fragmented`() { ... }
@Test fun `all fragments have correct messageId`() { ... }
@Test fun `fragments reassemble in any order`() { ... }
@Test fun `incomplete reassembly after TTL fires MESSAGE_EXPIRED`() { ... }
```

#### [NEW] `android/.../transport/DeduplicationTest.kt`
```kotlin
@Test fun `first occurrence is not duplicate`() { ... }
@Test fun `second occurrence is duplicate`() { ... }
@Test fun `LRU eviction does not create false negatives`() { ... }
```

---

## Verification Plan

### Network Failure Simulation

On a real device with USB debugging:
```bash
# Throttle BLE (not directly possible, simulate via software)
# Use two devices, manually toggle Bluetooth mid-transmission
# Observe: retransmission occurs, message eventually delivered
```

### Manual Test Scenarios

| Scenario | Expected Behavior |
|---|---|
| Toggle BLE mid-send | Retransmit on reconnect |
| Send duplicate packet | Second copy silently dropped |
| Expired message (> 60s) | NACK sent, MESSAGE_EXPIRED shown |
| Large message (> MTU) | Fragmented, reassembled correctly |
| Fragments arrive out of order | Reassembled in correct order |
| 3 consecutive send failures | SEND_FAILED event, error shown in UI |

### Performance Targets

| Metric | Target |
|---|---|
| Retransmit overhead (normal) | < 0 (no retransmit needed) |
| Max fragment reassembly time | < 2 seconds |
| Duplicate detection overhead | < 1 ms (LRU lookup) |
| Memory (fragment buffer) | < 5 MB |
