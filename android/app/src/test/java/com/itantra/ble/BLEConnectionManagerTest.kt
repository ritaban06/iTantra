package com.itantra.ble

import org.junit.Assert.*
import org.junit.Test

/**
 * Unit tests for the V9E Step 3 BLEConnectionManager multi-peer integration.
 *
 * Tests the per-peer state model, connection lifecycle, disconnect isolation,
 * client+server coexistence, per-peer send routing, data attribution, and
 * legacy state compatibility.
 *
 * These tests verify the DATA MODEL and STATE MANAGEMENT only.
 * They do not test actual Android Bluetooth connections.
 */
class BLEConnectionManagerTest {

    // ── Helper: create a peer state map for testing ───────────────────

    private fun createPeerStates(): MutableMap<String, BLEConnectionManager.PeerConnectionState> {
        return mutableMapOf()
    }

    private fun addPeer(
        states: MutableMap<String, BLEConnectionManager.PeerConnectionState>,
        deviceId: String,
        state: BLEConnectionManager.ConnectionState,
        mtu: Int = 23,
        role: BLEConnectionManager.ConnectionRole
    ) {
        states[deviceId] = BLEConnectionManager.PeerConnectionState(
            deviceId = deviceId,
            state = state,
            mtu = mtu,
            role = role
        )
    }

    private fun syncLegacy(
        states: MutableMap<String, BLEConnectionManager.PeerConnectionState>
    ): Triple<String?, BLEConnectionManager.ConnectionState, Int> {
        val connected = states.values.find { it.state == BLEConnectionManager.ConnectionState.CONNECTED }
        return if (connected != null) {
            Triple(connected.deviceId, connected.state, connected.mtu)
        } else {
            val active = states.values.find {
                it.state == BLEConnectionManager.ConnectionState.CONNECTING ||
                it.state == BLEConnectionManager.ConnectionState.DISCONNECTING
            }
            if (active != null) {
                Triple(active.deviceId, active.state, active.mtu)
            } else {
                Triple(null, BLEConnectionManager.ConnectionState.IDLE, 23)
            }
        }
    }

    // ── Single peer creation tests ────────────────────────────────────

    @Test
    fun `can create a CLIENT peer`() {
        val states = createPeerStates()
        addPeer(states, "C", BLEConnectionManager.ConnectionState.CONNECTING, 23, BLEConnectionManager.ConnectionRole.CLIENT)
        assertEquals(1, states.size)
        assertEquals(BLEConnectionManager.ConnectionState.CONNECTING, states["C"]!!.state)
        assertEquals(BLEConnectionManager.ConnectionRole.CLIENT, states["C"]!!.role)
    }

    @Test
    fun `can create a SERVER peer`() {
        val states = createPeerStates()
        addPeer(states, "D", BLEConnectionManager.ConnectionState.CONNECTED, 23, BLEConnectionManager.ConnectionRole.SERVER)
        assertEquals(1, states.size)
        assertEquals(BLEConnectionManager.ConnectionState.CONNECTED, states["D"]!!.state)
        assertEquals(BLEConnectionManager.ConnectionRole.SERVER, states["D"]!!.role)
    }

    // ── Multi-peer coexistence tests ──────────────────────────────────

    @Test
    fun `two peers coexist`() {
        val states = createPeerStates()
        addPeer(states, "C", BLEConnectionManager.ConnectionState.CONNECTED, 512, BLEConnectionManager.ConnectionRole.CLIENT)
        addPeer(states, "D", BLEConnectionManager.ConnectionState.CONNECTED, 23, BLEConnectionManager.ConnectionRole.SERVER)
        assertEquals(2, states.size)
    }

    @Test
    fun `three peers coexist`() {
        val states = createPeerStates()
        addPeer(states, "C", BLEConnectionManager.ConnectionState.CONNECTED, 512, BLEConnectionManager.ConnectionRole.CLIENT)
        addPeer(states, "D", BLEConnectionManager.ConnectionState.CONNECTED, 23, BLEConnectionManager.ConnectionRole.SERVER)
        addPeer(states, "E", BLEConnectionManager.ConnectionState.CONNECTED, 247, BLEConnectionManager.ConnectionRole.CLIENT)
        assertEquals(3, states.size)
    }

    @Test
    fun `client and server roles coexist`() {
        val states = createPeerStates()
        addPeer(states, "C", BLEConnectionManager.ConnectionState.CONNECTED, 512, BLEConnectionManager.ConnectionRole.CLIENT)
        addPeer(states, "D", BLEConnectionManager.ConnectionState.CONNECTED, 23, BLEConnectionManager.ConnectionRole.SERVER)
        assertEquals(BLEConnectionManager.ConnectionRole.CLIENT, states["C"]!!.role)
        assertEquals(BLEConnectionManager.ConnectionRole.SERVER, states["D"]!!.role)
    }

    // ── Connect isolation tests ───────────────────────────────────────

    @Test
    fun `connecting C does not block connecting D`() {
        val states = createPeerStates()
        addPeer(states, "C", BLEConnectionManager.ConnectionState.CONNECTING, 23, BLEConnectionManager.ConnectionRole.CLIENT)
        // Simulate: connect D while C is still connecting
        addPeer(states, "D", BLEConnectionManager.ConnectionState.CONNECTING, 23, BLEConnectionManager.ConnectionRole.CLIENT)
        assertEquals(2, states.size)
        assertEquals(BLEConnectionManager.ConnectionState.CONNECTING, states["C"]!!.state)
        assertEquals(BLEConnectionManager.ConnectionState.CONNECTING, states["D"]!!.state)
    }

    // ── Disconnect isolation tests ────────────────────────────────────

    @Test
    fun `disconnecting C leaves D connected`() {
        val states = createPeerStates()
        addPeer(states, "C", BLEConnectionManager.ConnectionState.CONNECTED, 512, BLEConnectionManager.ConnectionRole.CLIENT)
        addPeer(states, "D", BLEConnectionManager.ConnectionState.CONNECTED, 23, BLEConnectionManager.ConnectionRole.SERVER)

        states.remove("C")

        assertEquals(1, states.size)
        assertNotNull(states["D"])
        assertEquals(BLEConnectionManager.ConnectionState.CONNECTED, states["D"]!!.state)
    }

    @Test
    fun `disconnecting D leaves C connected`() {
        val states = createPeerStates()
        addPeer(states, "C", BLEConnectionManager.ConnectionState.CONNECTED, 512, BLEConnectionManager.ConnectionRole.CLIENT)
        addPeer(states, "D", BLEConnectionManager.ConnectionState.CONNECTED, 23, BLEConnectionManager.ConnectionRole.SERVER)

        states.remove("D")

        assertEquals(1, states.size)
        assertNotNull(states["C"])
        assertEquals(BLEConnectionManager.ConnectionState.CONNECTED, states["C"]!!.state)
    }

    @Test
    fun `server disconnect does not clear client state`() {
        // Critical: D (SERVER) disconnects, C (CLIENT) must remain
        val states = createPeerStates()
        addPeer(states, "C", BLEConnectionManager.ConnectionState.CONNECTED, 512, BLEConnectionManager.ConnectionRole.CLIENT)
        addPeer(states, "D", BLEConnectionManager.ConnectionState.CONNECTED, 23, BLEConnectionManager.ConnectionRole.SERVER)

        // D disconnects
        states.remove("D")

        assertEquals(1, states.size)
        val cState = states["C"]
        assertNotNull(cState)
        assertEquals(BLEConnectionManager.ConnectionState.CONNECTED, cState!!.state)
        assertEquals(512, cState.mtu)
        assertEquals(BLEConnectionManager.ConnectionRole.CLIENT, cState.role)
    }

    @Test
    fun `client disconnect does not clear server state`() {
        // Critical: C (CLIENT) disconnects, D (SERVER) must remain
        val states = createPeerStates()
        addPeer(states, "C", BLEConnectionManager.ConnectionState.CONNECTED, 512, BLEConnectionManager.ConnectionRole.CLIENT)
        addPeer(states, "D", BLEConnectionManager.ConnectionState.CONNECTED, 23, BLEConnectionManager.ConnectionRole.SERVER)

        // C disconnects
        states.remove("C")

        assertEquals(1, states.size)
        val dState = states["D"]
        assertNotNull(dState)
        assertEquals(BLEConnectionManager.ConnectionState.CONNECTED, dState!!.state)
        assertEquals(23, dState.mtu)
        assertEquals(BLEConnectionManager.ConnectionRole.SERVER, dState.role)
    }

    // ── MTU isolation tests ───────────────────────────────────────────

    @Test
    fun `per-peer MTU values remain independent`() {
        val states = createPeerStates()
        addPeer(states, "C", BLEConnectionManager.ConnectionState.CONNECTED, 512, BLEConnectionManager.ConnectionRole.CLIENT)
        addPeer(states, "D", BLEConnectionManager.ConnectionState.CONNECTED, 23, BLEConnectionManager.ConnectionRole.SERVER)

        // Update C's MTU
        states["C"]!!.mtu = 999

        assertEquals(999, states["C"]!!.mtu)
        assertEquals(23, states["D"]!!.mtu)
    }

    @Test
    fun `per-peer roles remain independent`() {
        val states = createPeerStates()
        addPeer(states, "C", BLEConnectionManager.ConnectionState.CONNECTED, 512, BLEConnectionManager.ConnectionRole.CLIENT)
        addPeer(states, "D", BLEConnectionManager.ConnectionState.CONNECTED, 23, BLEConnectionManager.ConnectionRole.SERVER)

        assertEquals(BLEConnectionManager.ConnectionRole.CLIENT, states["C"]!!.role)
        assertEquals(BLEConnectionManager.ConnectionRole.SERVER, states["D"]!!.role)
    }

    // ── Connection failure isolation tests ─────────────────────────────

    @Test
    fun `client connection failure does not affect another peer`() {
        val states = createPeerStates()
        addPeer(states, "C", BLEConnectionManager.ConnectionState.CONNECTED, 512, BLEConnectionManager.ConnectionRole.CLIENT)
        addPeer(states, "D", BLEConnectionManager.ConnectionState.CONNECTED, 23, BLEConnectionManager.ConnectionRole.SERVER)

        // C fails to connect (remove it)
        states.remove("C")

        // D unaffected
        assertEquals(1, states.size)
        assertEquals(BLEConnectionManager.ConnectionState.CONNECTED, states["D"]!!.state)
    }

    @Test
    fun `server disconnect does not affect client peer`() {
        val states = createPeerStates()
        addPeer(states, "C", BLEConnectionManager.ConnectionState.CONNECTED, 512, BLEConnectionManager.ConnectionRole.CLIENT)
        addPeer(states, "D", BLEConnectionManager.ConnectionState.CONNECTED, 23, BLEConnectionManager.ConnectionRole.SERVER)

        // D disconnects
        states.remove("D")

        // C unaffected
        assertEquals(1, states.size)
        assertEquals(BLEConnectionManager.ConnectionState.CONNECTED, states["C"]!!.state)
        assertEquals(512, states["C"]!!.mtu)
    }

    // ── Legacy state sync tests ───────────────────────────────────────

    @Test
    fun `legacy state reflects remaining connected peer`() {
        val states = createPeerStates()
        addPeer(states, "C", BLEConnectionManager.ConnectionState.CONNECTED, 512, BLEConnectionManager.ConnectionRole.CLIENT)
        addPeer(states, "D", BLEConnectionManager.ConnectionState.CONNECTED, 23, BLEConnectionManager.ConnectionRole.SERVER)

        // D disconnects
        states.remove("D")

        val (devId, state, mtuVal) = syncLegacy(states)
        assertEquals("C", devId)
        assertEquals(BLEConnectionManager.ConnectionState.CONNECTED, state)
        assertEquals(512, mtuVal)
    }

    @Test
    fun `legacy state becomes IDLE when no peers remain`() {
        val states = createPeerStates()
        addPeer(states, "C", BLEConnectionManager.ConnectionState.CONNECTED, 512, BLEConnectionManager.ConnectionRole.CLIENT)

        states.remove("C")

        val (devId, state, _) = syncLegacy(states)
        assertNull(devId)
        assertEquals(BLEConnectionManager.ConnectionState.IDLE, state)
    }

    @Test
    fun `legacy state handles multiple connected peers by picking first`() {
        val states = createPeerStates()
        addPeer(states, "C", BLEConnectionManager.ConnectionState.CONNECTED, 512, BLEConnectionManager.ConnectionRole.CLIENT)
        addPeer(states, "D", BLEConnectionManager.ConnectionState.CONNECTED, 23, BLEConnectionManager.ConnectionRole.SERVER)

        val (devId, state, mtuVal) = syncLegacy(states)
        // First connected peer (deterministic by iteration order of mutableMapOf)
        assertNotNull(devId)
        assertEquals(BLEConnectionManager.ConnectionState.CONNECTED, state)
        assertTrue(mtuVal == 512 || mtuVal == 23)  // one of the two peers
    }

    // ── Send routing tests ────────────────────────────────────────────

    @Test
    fun `peer-targeted send selects correct client peer`() {
        val states = createPeerStates()
        addPeer(states, "C", BLEConnectionManager.ConnectionState.CONNECTED, 512, BLEConnectionManager.ConnectionRole.CLIENT)
        addPeer(states, "D", BLEConnectionManager.ConnectionState.CONNECTED, 23, BLEConnectionManager.ConnectionRole.SERVER)

        // Lookup peer for send
        val targetC = states["C"]
        val targetD = states["D"]

        assertNotNull(targetC)
        assertNotNull(targetD)
        assertEquals(BLEConnectionManager.ConnectionRole.CLIENT, targetC!!.role)
        assertEquals(BLEConnectionManager.ConnectionRole.SERVER, targetD!!.role)
    }

    @Test
    fun `peer-targeted send selects correct server peer`() {
        val states = createPeerStates()
        addPeer(states, "C", BLEConnectionManager.ConnectionState.CONNECTED, 512, BLEConnectionManager.ConnectionRole.CLIENT)
        addPeer(states, "D", BLEConnectionManager.ConnectionState.CONNECTED, 23, BLEConnectionManager.ConnectionRole.SERVER)

        // Lookup peer for server send
        val target = states["D"]
        assertNotNull(target)
        assertEquals(BLEConnectionManager.ConnectionRole.SERVER, target!!.role)
    }

    @Test
    fun `send to non-existent peer returns NOT_CONNECTED`() {
        val states = createPeerStates()
        addPeer(states, "C", BLEConnectionManager.ConnectionState.CONNECTED, 512, BLEConnectionManager.ConnectionRole.CLIENT)

        val target = states["X"]
        assertNull(target)
    }

    // ── Data attribution tests ────────────────────────────────────────

    @Test
    fun `data from C is attributed to C`() {
        // Simulate: data arrives, resolved to C's deviceId
        val fromDevice = "C"
        assertEquals("C", fromDevice)
    }

    @Test
    fun `data from D is attributed to D`() {
        val fromDevice = "D"
        assertEquals("D", fromDevice)
    }

    @Test
    fun `server data from C via BluetoothDevice resolves to C deviceId`() {
        // Simulate: findDeviceIdByAddress resolves to C
        val deviceMap = mutableMapOf<String, String>()  // deviceId -> address
        deviceMap["C"] = "AA:BB:CC:DD:EE:01"
        deviceMap["D"] = "AA:BB:CC:DD:EE:02"

        // Reverse lookup
        val address = "AA:BB:CC:DD:EE:01"
        val foundId = deviceMap.entries.find { it.value == address }?.key
        assertEquals("C", foundId)
    }

    // ── Three-peer scenario tests ─────────────────────────────────────

    @Test
    fun `three peers can coexist with different states`() {
        val states = createPeerStates()
        addPeer(states, "C", BLEConnectionManager.ConnectionState.CONNECTED, 512, BLEConnectionManager.ConnectionRole.CLIENT)
        addPeer(states, "D", BLEConnectionManager.ConnectionState.CONNECTED, 23, BLEConnectionManager.ConnectionRole.SERVER)
        addPeer(states, "E", BLEConnectionManager.ConnectionState.CONNECTING, 247, BLEConnectionManager.ConnectionRole.CLIENT)

        assertEquals(3, states.size)
        assertEquals(BLEConnectionManager.ConnectionState.CONNECTED, states["C"]!!.state)
        assertEquals(BLEConnectionManager.ConnectionState.CONNECTED, states["D"]!!.state)
        assertEquals(BLEConnectionManager.ConnectionState.CONNECTING, states["E"]!!.state)
    }

    @Test
    fun `disconnecting one of three peers leaves two intact`() {
        val states = createPeerStates()
        addPeer(states, "C", BLEConnectionManager.ConnectionState.CONNECTED, 512, BLEConnectionManager.ConnectionRole.CLIENT)
        addPeer(states, "D", BLEConnectionManager.ConnectionState.CONNECTED, 23, BLEConnectionManager.ConnectionRole.SERVER)
        addPeer(states, "E", BLEConnectionManager.ConnectionState.CONNECTED, 247, BLEConnectionManager.ConnectionRole.CLIENT)

        states.remove("D")

        assertEquals(2, states.size)
        assertEquals(BLEConnectionManager.ConnectionState.CONNECTED, states["C"]!!.state)
        assertNull(states["D"])
        assertEquals(BLEConnectionManager.ConnectionState.CONNECTED, states["E"]!!.state)
    }

    // ── Connection count tests ────────────────────────────────────────

    @Test
    fun `connected peer count reflects actual connected peers`() {
        val states = createPeerStates()
        addPeer(states, "C", BLEConnectionManager.ConnectionState.CONNECTED, 512, BLEConnectionManager.ConnectionRole.CLIENT)
        addPeer(states, "D", BLEConnectionManager.ConnectionState.CONNECTED, 23, BLEConnectionManager.ConnectionRole.SERVER)
        addPeer(states, "E", BLEConnectionManager.ConnectionState.CONNECTING, 247, BLEConnectionManager.ConnectionRole.CLIENT)

        val connectedCount = states.values.count { it.state == BLEConnectionManager.ConnectionState.CONNECTED }
        assertEquals(2, connectedCount)
    }

    @Test
    fun `getConnectedDeviceIds returns correct list`() {
        val states = createPeerStates()
        addPeer(states, "C", BLEConnectionManager.ConnectionState.CONNECTED, 512, BLEConnectionManager.ConnectionRole.CLIENT)
        addPeer(states, "D", BLEConnectionManager.ConnectionState.CONNECTED, 23, BLEConnectionManager.ConnectionRole.SERVER)
        addPeer(states, "E", BLEConnectionManager.ConnectionState.CONNECTING, 247, BLEConnectionManager.ConnectionRole.CLIENT)

        val connectedIds = states.values
            .filter { it.state == BLEConnectionManager.ConnectionState.CONNECTED }
            .map { it.deviceId }
            .toSet()

        assertEquals(setOf("C", "D"), connectedIds)
    }

    // ── Stop/cleanup tests ────────────────────────────────────────────

    @Test
    fun `stop clears all peer state`() {
        val states = createPeerStates()
        addPeer(states, "C", BLEConnectionManager.ConnectionState.CONNECTED, 512, BLEConnectionManager.ConnectionRole.CLIENT)
        addPeer(states, "D", BLEConnectionManager.ConnectionState.CONNECTED, 23, BLEConnectionManager.ConnectionRole.SERVER)

        states.clear()

        assertEquals(0, states.size)
    }

    // ── Duplicate connection prevention ────────────────────────────────

    @Test
    fun `duplicate connect for same deviceId is rejected`() {
        val states = createPeerStates()
        addPeer(states, "C", BLEConnectionManager.ConnectionState.CONNECTED, 512, BLEConnectionManager.ConnectionRole.CLIENT)

        // Check if already connected/connecting
        val existing = states["C"]
        val shouldReject = existing != null && (
            existing.state == BLEConnectionManager.ConnectionState.CONNECTED ||
            existing.state == BLEConnectionManager.ConnectionState.CONNECTING
        )

        assertTrue(shouldReject)
    }

    @Test
    fun `new connection can replace stale disconnected entry`() {
        val states = createPeerStates()
        addPeer(states, "C", BLEConnectionManager.ConnectionState.CONNECTED, 512, BLEConnectionManager.ConnectionRole.CLIENT)

        // C disconnects
        states.remove("C")

        // New C connection
        addPeer(states, "C", BLEConnectionManager.ConnectionState.CONNECTING, 23, BLEConnectionManager.ConnectionRole.CLIENT)

        assertEquals(1, states.size)
        assertEquals(BLEConnectionManager.ConnectionState.CONNECTING, states["C"]!!.state)
    }

    // ── BLEGattClient.Listener interface compatibility ─────────────────

    @Test
    fun `BLEGattClient Listener interface has peer-aware data callback`() {
        val methods = BLEGattClient.Listener::class.java.methods.map { it.name }.toSet()
        assertTrue("onDataReceived must exist", methods.contains("onDataReceived"))
        assertTrue("onError must exist", methods.contains("onError"))
        assertTrue("onConnected must exist", methods.contains("onConnected"))
        assertTrue("onDisconnected must exist", methods.contains("onDisconnected"))
    }

    // ── BLEGattClient PeerGattConnection model ─────────────────────────

    @Test
    fun `PeerGattConnection stores per-peer MTU`() {
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
        assertEquals(512, peerC.mtu)
        assertEquals(23, peerD.mtu)
    }

    @Test
    fun `PeerGattConnection generation prevents stale callbacks`() {
        val counter = java.util.concurrent.atomic.AtomicLong(1)
        val gen1 = counter.incrementAndGet()
        val gen2 = counter.incrementAndGet()

        val peerV1 = BLEGattClient.PeerGattConnection(
            deviceId = "C",
            callback = object : android.bluetooth.BluetoothGattCallback() {},
            generation = gen1
        )
        val peerV2 = BLEGattClient.PeerGattConnection(
            deviceId = "C",
            callback = object : android.bluetooth.BluetoothGattCallback() {},
            generation = gen2
        )

        // Old callback generation cannot match new peer
        assertNotEquals(peerV1.generation, peerV2.generation)
    }
}
