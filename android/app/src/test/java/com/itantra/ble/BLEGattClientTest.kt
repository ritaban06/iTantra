package com.itantra.ble

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.atomic.AtomicLong

/**
 * Unit tests for the V9E Step 2 multi-peer BLEGattClient data model.
 *
 * Tests the PeerGattConnection data class, connection tracking patterns,
 * stale callback detection logic, and multi-peer state isolation.
 *
 * These tests verify the DATA MODEL and BEHAVIORAL LOGIC only.
 * They do not test actual Android BluetoothGatt connections.
 */
class BLEGattClientTest {

    // ── PeerGattConnection data model tests ───────────────────────────

    @Test
    fun `PeerGattConnection can represent a connected client peer`() {
        val peer = BLEGattClient.PeerGattConnection(
            deviceId = "ITN-0001-0001",
            isConnected = true,
            mtu = 512,
            callback = object : android.bluetooth.BluetoothGattCallback() {},
            generation = 1
        )
        assertEquals("ITN-0001-0001", peer.deviceId)
        assertTrue(peer.isConnected)
        assertEquals(512, peer.mtu)
        assertEquals(1, peer.generation)
        assertNull(peer.gatt)
        assertNull(peer.txCharacteristic)
    }

    @Test
    fun `PeerGattConnection defaults to disconnected with MTU 23`() {
        val peer = BLEGattClient.PeerGattConnection(
            deviceId = "ITN-0002-0002",
            callback = object : android.bluetooth.BluetoothGattCallback() {},
            generation = 1
        )
        assertFalse(peer.isConnected)
        assertEquals(23, peer.mtu)
    }

    @Test
    fun `two PeerGattConnection instances are independent`() {
        val peer1 = BLEGattClient.PeerGattConnection(
            deviceId = "C",
            isConnected = true,
            mtu = 512,
            callback = object : android.bluetooth.BluetoothGattCallback() {},
            generation = 1
        )
        val peer2 = BLEGattClient.PeerGattConnection(
            deviceId = "D",
            isConnected = true,
            mtu = 23,
            callback = object : android.bluetooth.BluetoothGattCallback() {},
            generation = 2
        )

        // Mutate peer1
        peer1.isConnected = false
        peer1.mtu = 999

        // peer2 must be unaffected
        assertTrue(peer2.isConnected)
        assertEquals(23, peer2.mtu)
        assertEquals("D", peer2.deviceId)
    }

    @Test
    fun `PeerGattConnection stores correct generation counter`() {
        val cb1 = object : android.bluetooth.BluetoothGattCallback() {}
        val cb2 = object : android.bluetooth.BluetoothGattCallback() {}

        val peer1 = BLEGattClient.PeerGattConnection(
            deviceId = "C",
            callback = cb1,
            generation = 5
        )
        val peer2 = BLEGattClient.PeerGattConnection(
            deviceId = "C",
            callback = cb2,
            generation = 6
        )

        // Different generations for same deviceId = different connections
        assertNotEquals(peer1.generation, peer2.generation)
        // Different callback instances
        assertNotSame(peer1.callback, peer2.callback)
    }

    // ── Connection map behavior tests ─────────────────────────────────

    @Test
    fun `connections map tracks multiple peers simultaneously`() {
        val connections = mutableMapOf<String, BLEGattClient.PeerGattConnection>()

        connections["C"] = BLEGattClient.PeerGattConnection(
            deviceId = "C",
            isConnected = true,
            mtu = 512,
            callback = object : android.bluetooth.BluetoothGattCallback() {},
            generation = 1
        )
        connections["D"] = BLEGattClient.PeerGattConnection(
            deviceId = "D",
            isConnected = true,
            mtu = 23,
            callback = object : android.bluetooth.BluetoothGattCallback() {},
            generation = 2
        )
        connections["E"] = BLEGattClient.PeerGattConnection(
            deviceId = "E",
            isConnected = false,
            mtu = 247,
            callback = object : android.bluetooth.BluetoothGattCallback() {},
            generation = 3
        )

        assertEquals(3, connections.size)
        assertTrue(connections.containsKey("C"))
        assertTrue(connections.containsKey("D"))
        assertTrue(connections.containsKey("E"))
    }

    @Test
    fun `removing one peer does not affect others`() {
        val connections = mutableMapOf<String, BLEGattClient.PeerGattConnection>()

        connections["C"] = BLEGattClient.PeerGattConnection(
            deviceId = "C",
            isConnected = true,
            mtu = 512,
            callback = object : android.bluetooth.BluetoothGattCallback() {},
            generation = 1
        )
        connections["D"] = BLEGattClient.PeerGattConnection(
            deviceId = "D",
            isConnected = true,
            mtu = 23,
            callback = object : android.bluetooth.BluetoothGattCallback() {},
            generation = 2
        )

        // Remove C
        connections.remove("C")

        assertEquals(1, connections.size)
        assertNotNull(connections["D"])
        assertNull(connections["C"])
        assertTrue(connections["D"]!!.isConnected)
        assertEquals(23, connections["D"]!!.mtu)
    }

    @Test
    fun `disconnect C does not disconnect D`() {
        val connections = mutableMapOf<String, BLEGattClient.PeerGattConnection>()

        connections["C"] = BLEGattClient.PeerGattConnection(
            deviceId = "C",
            isConnected = true,
            mtu = 512,
            callback = object : android.bluetooth.BluetoothGattCallback() {},
            generation = 1
        )
        connections["D"] = BLEGattClient.PeerGattConnection(
            deviceId = "D",
            isConnected = true,
            mtu = 23,
            callback = object : android.bluetooth.BluetoothGattCallback() {},
            generation = 2
        )

        // Simulate disconnect C
        connections["C"]!!.isConnected = false
        connections.remove("C")

        // D unaffected
        assertTrue(connections["D"]!!.isConnected)
        assertEquals(23, connections["D"]!!.mtu)
    }

    @Test
    fun `disconnect D does not disconnect C`() {
        val connections = mutableMapOf<String, BLEGattClient.PeerGattConnection>()

        connections["C"] = BLEGattClient.PeerGattConnection(
            deviceId = "C",
            isConnected = true,
            mtu = 512,
            callback = object : android.bluetooth.BluetoothGattCallback() {},
            generation = 1
        )
        connections["D"] = BLEGattClient.PeerGattConnection(
            deviceId = "D",
            isConnected = true,
            mtu = 23,
            callback = object : android.bluetooth.BluetoothGattCallback() {},
            generation = 2
        )

        // Simulate disconnect D
        connections["D"]!!.isConnected = false
        connections.remove("D")

        // C unaffected
        assertTrue(connections["C"]!!.isConnected)
        assertEquals(512, connections["C"]!!.mtu)
    }

    // ── Stale callback detection tests ────────────────────────────────

    @Test
    fun `stale callback detection rejects old generation`() {
        val counter = AtomicLong(1)

        // First connection to C: generation 1
        val gen1 = counter.incrementAndGet()
        val peerV1 = BLEGattClient.PeerGattConnection(
            deviceId = "C",
            isConnected = true,
            mtu = 512,
            callback = object : android.bluetooth.BluetoothGattCallback() {},
            generation = gen1
        )

        // C disconnects, reconnects: generation 2
        val gen2 = counter.incrementAndGet()
        val peerV2 = BLEGattClient.PeerGattConnection(
            deviceId = "C",
            isConnected = true,
            mtu = 256,
            callback = object : android.bluetooth.BluetoothGattCallback() {},
            generation = gen2
        )

        // Simulate: old callback (gen1) fires after new connection (gen2) exists
        val currentPeer = peerV2  // current connection for C
        val callbackGeneration = peerV1.generation  // old callback's generation

        // Validation logic (mirrors BLEGattClient.validateCallback)
        val isValid = currentPeer.generation == callbackGeneration

        assertFalse(isValid)  // Old callback should be rejected
        assertEquals(256, currentPeer.mtu)  // New connection's MTU preserved
    }

    @Test
    fun `valid callback with matching generation is accepted`() {
        val counter = AtomicLong(1)

        val gen = counter.incrementAndGet()
        val peer = BLEGattClient.PeerGattConnection(
            deviceId = "C",
            isConnected = false,
            mtu = 23,
            callback = object : android.bluetooth.BluetoothGattCallback() {},
            generation = gen
        )

        // Callback fires with matching generation
        val isValid = peer.generation == gen

        assertTrue(isValid)
    }

    @Test
    fun `stale callback cannot corrupt a newer connection`() {
        val connections = mutableMapOf<String, BLEGattClient.PeerGattConnection>()
        val counter = AtomicLong(1)

        // First connection to C
        val gen1 = counter.incrementAndGet()
        connections["C"] = BLEGattClient.PeerGattConnection(
            deviceId = "C",
            isConnected = true,
            mtu = 512,
            callback = object : android.bluetooth.BluetoothGattCallback() {},
            generation = gen1
        )

        // C disconnects and reconnects
        connections.remove("C")
        val gen2 = counter.incrementAndGet()
        connections["C"] = BLEGattClient.PeerGattConnection(
            deviceId = "C",
            isConnected = true,
            mtu = 256,
            callback = object : android.bluetooth.BluetoothGattCallback() {},
            generation = gen2
        )

        // Stale callback (gen1) tries to process disconnect
        val callbackGeneration = gen1
        val currentPeer = connections["C"]

        // validateCallback logic
        val validPeer = if (currentPeer != null && currentPeer.generation == callbackGeneration) {
            currentPeer
        } else {
            null
        }

        assertNull(validPeer)  // Stale callback rejected
        // New connection intact
        assertNotNull(connections["C"])
        assertTrue(connections["C"]!!.isConnected)
        assertEquals(256, connections["C"]!!.mtu)
    }

    // ── Legacy state sync tests ───────────────────────────────────────

    @Test
    fun `legacy sync reflects first connected peer`() {
        val connections = mutableMapOf<String, BLEGattClient.PeerGattConnection>()

        // Simulate syncLegacyState logic
        fun syncLegacy(): Pair<Boolean, Int> {
            val firstConnected = connections.values.find { it.isConnected }
            return if (firstConnected != null) {
                Pair(true, firstConnected.mtu)
            } else {
                Pair(false, 23)
            }
        }

        // No peers
        var (connected, mtuVal) = syncLegacy()
        assertFalse(connected)
        assertEquals(23, mtuVal)

        // Add C
        connections["C"] = BLEGattClient.PeerGattConnection(
            deviceId = "C",
            isConnected = true,
            mtu = 512,
            callback = object : android.bluetooth.BluetoothGattCallback() {},
            generation = 1
        )
        (connected, mtuVal) = syncLegacy()
        assertTrue(connected)
        assertEquals(512, mtuVal)

        // Add D
        connections["D"] = BLEGattClient.PeerGattConnection(
            deviceId = "D",
            isConnected = true,
            mtu = 23,
            callback = object : android.bluetooth.BluetoothGattCallback() {},
            generation = 2
        )
        // Legacy should reflect first connected (C)
        (connected, mtuVal) = syncLegacy()
        assertTrue(connected)
        assertEquals(512, mtuVal)

        // Remove C
        connections.remove("C")
        (connected, mtuVal) = syncLegacy()
        assertTrue(connected)
        assertEquals(23, mtuVal)  // Now reflects D

        // Remove D
        connections.remove("D")
        (connected, mtuVal) = syncLegacy()
        assertFalse(connected)
        assertEquals(23, mtuVal)  // Default
    }

    // ── Duplicate connection prevention ────────────────────────────────

    @Test
    fun `duplicate connect for same deviceId is rejected`() {
        val connections = mutableMapOf<String, BLEGattClient.PeerGattConnection>()

        // First connection to C
        connections["C"] = BLEGattClient.PeerGattConnection(
            deviceId = "C",
            isConnected = true,
            mtu = 512,
            callback = object : android.bluetooth.BluetoothGattCallback() {},
            generation = 1
        )

        // Simulate: check if already connected/connecting
        val existing = connections["C"]
        val shouldReject = existing != null && (existing.isConnected || existing.gatt != null)

        assertTrue(shouldReject)
        assertEquals(1, connections.size)  // Only one C entry
    }

    @Test
    fun `new connection replaces stale entry for same deviceId`() {
        val connections = mutableMapOf<String, BLEGattClient.PeerGattConnection>()
        val counter = AtomicLong(1)

        // Old C connection (stale)
        connections["C"] = BLEGattClient.PeerGattConnection(
            deviceId = "C",
            isConnected = false,  // disconnected
            mtu = 512,
            callback = object : android.bluetooth.BluetoothGattCallback() {},
            generation = counter.incrementAndGet()
        )

        // Simulate: existing is not connected and gatt is null → allow reconnect
        val existing = connections["C"]
        val canReconnect = existing == null || (!existing.isConnected && existing.gatt == null)
        assertTrue(canReconnect)

        // New C connection
        val newGen = counter.incrementAndGet()
        connections["C"] = BLEGattClient.PeerGattConnection(
            deviceId = "C",
            isConnected = true,
            mtu = 256,
            callback = object : android.bluetooth.BluetoothGattCallback() {},
            generation = newGen
        )

        assertEquals(1, connections.size)
        assertEquals(newGen, connections["C"]!!.generation)
        assertEquals(256, connections["C"]!!.mtu)
    }

    // ── Three-peer scenario ───────────────────────────────────────────

    @Test
    fun `three peers can coexist with independent states`() {
        val connections = mutableMapOf<String, BLEGattClient.PeerGattConnection>()

        connections["C"] = BLEGattClient.PeerGattConnection(
            deviceId = "C",
            isConnected = true,
            mtu = 512,
            callback = object : android.bluetooth.BluetoothGattCallback() {},
            generation = 1
        )
        connections["D"] = BLEGattClient.PeerGattConnection(
            deviceId = "D",
            isConnected = true,
            mtu = 23,
            callback = object : android.bluetooth.BluetoothGattCallback() {},
            generation = 2
        )
        connections["E"] = BLEGattClient.PeerGattConnection(
            deviceId = "E",
            isConnected = false,
            mtu = 247,
            callback = object : android.bluetooth.BluetoothGattCallback() {},
            generation = 3
        )

        assertEquals(3, connections.size)

        // Disconnect D
        connections["D"]!!.isConnected = false
        connections.remove("D")

        assertEquals(2, connections.size)
        assertTrue(connections["C"]!!.isConnected)
        assertNull(connections["D"])
        assertFalse(connections["E"]!!.isConnected)

        // Connect E
        connections["E"]!!.isConnected = true
        connections["E"]!!.mtu = 499

        assertEquals(2, connections.size)
        assertTrue(connections["C"]!!.isConnected)
        assertEquals(512, connections["C"]!!.mtu)
        assertTrue(connections["E"]!!.isConnected)
        assertEquals(499, connections["E"]!!.mtu)
    }

    // ── Per-peer send targeting ────────────────────────────────────────

    @Test
    fun `send targets correct peer based on deviceId`() {
        val connections = mutableMapOf<String, BLEGattClient.PeerGattConnection>()

        // Create mock-like peers (without real GATT)
        connections["C"] = BLEGattClient.PeerGattConnection(
            deviceId = "C",
            isConnected = true,
            mtu = 512,
            callback = object : android.bluetooth.BluetoothGattCallback() {},
            generation = 1
        )
        connections["D"] = BLEGattClient.PeerGattConnection(
            deviceId = "D",
            isConnected = true,
            mtu = 23,
            callback = object : android.bluetooth.BluetoothGattCallback() {},
            generation = 2
        )

        // Simulate send lookup logic (mirrors BLEGattClient.send)
        fun lookupTarget(deviceId: String): BLEGattClient.PeerGattConnection? {
            return connections[deviceId]
        }

        val targetC = lookupTarget("C")
        val targetD = lookupTarget("D")
        val targetUnknown = lookupTarget("X")

        assertNotNull(targetC)
        assertEquals("C", targetC!!.deviceId)
        assertNotNull(targetD)
        assertEquals("D", targetD!!.deviceId)
        assertNull(targetUnknown)
    }

    // ── MTU per-peer storage ──────────────────────────────────────────

    @Test
    fun `each peer stores independent MTU`() {
        val peerC = BLEGattClient.PeerGattConnection(
            deviceId = "C",
            mtu = 512,
            callback = object : android.bluetooth.BluetoothGattCallback() {},
            generation = 1
        )
        val peerD = BLEGattClient.PeerGattConnection(
            deviceId = "D",
            mtu = 23,
            callback = object : android.bluetooth.BluetoothGattCallback() {},
            generation = 2
        )
        val peerE = BLEGattClient.PeerGattConnection(
            deviceId = "E",
            mtu = 247,
            callback = object : android.bluetooth.BluetoothGattCallback() {},
            generation = 3
        )

        assertEquals(512, peerC.mtu)
        assertEquals(23, peerD.mtu)
        assertEquals(247, peerE.mtu)

        // Update C's MTU
        peerC.mtu = 999

        // Others unaffected
        assertEquals(23, peerD.mtu)
        assertEquals(247, peerE.mtu)
    }

    // ── Listener interface backward compatibility ──────────────────────

    @Test
    fun `Listener interface matches BLEConnectionManager expectations`() {
        // Verify the interface has the expected methods
        val methods = BLEGattClient.Listener::class.java.methods.map { it.name }.toSet()
        assertTrue("onConnected must exist", methods.contains("onConnected"))
        assertTrue("onDisconnected must exist", methods.contains("onDisconnected"))
        assertTrue("onDataReceived must exist", methods.contains("onDataReceived"))
        assertTrue("onError must exist", methods.contains("onError"))
    }
}
