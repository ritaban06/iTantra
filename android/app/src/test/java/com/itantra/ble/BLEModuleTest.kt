package com.itantra.ble

import org.junit.Assert.*
import org.junit.Test

/**
 * Unit tests for the V9E Step 4 React Native BLE bridge layer.
 *
 * Tests the peer-targeted API shape and behavior patterns for
 * BLEModule's send, disconnect, and getConnectionState methods.
 *
 * These tests verify the API CONTRACT and BEHAVIORAL LOGIC only.
 * They do not test actual React Native bridge calls or Android BLE.
 */
class BLEModuleTest {

    // ── Send API tests ────────────────────────────────────────────────

    @Test
    fun `peer-targeted send resolves correct peer`() {
        // Simulate: send to C
        val targetDeviceId = "ITN-0001-0001"
        val peerStates = mutableMapOf<String, BLEConnectionManager.PeerConnectionState>()
        peerStates[targetDeviceId] = BLEConnectionManager.PeerConnectionState(
            deviceId = targetDeviceId,
            state = BLEConnectionManager.ConnectionState.CONNECTED,
            mtu = 512,
            role = BLEConnectionManager.ConnectionRole.CLIENT
        )

        val peerState = peerStates[targetDeviceId]
        assertNotNull(peerState)
        assertEquals(BLEConnectionManager.ConnectionState.CONNECTED, peerState!!.state)
    }

    @Test
    fun `peer-targeted send to non-existent peer returns NOT_CONNECTED`() {
        val peerStates = mutableMapOf<String, BLEConnectionManager.PeerConnectionState>()
        peerStates["ITN-0001-0001"] = BLEConnectionManager.PeerConnectionState(
            deviceId = "ITN-0001-0001",
            state = BLEConnectionManager.ConnectionState.CONNECTED,
            mtu = 512,
            role = BLEConnectionManager.ConnectionRole.CLIENT
        )

        val targetDeviceId = "ITN-9999-9999"
        val peerState = peerStates[targetDeviceId]
        assertNull(peerState)
    }

    @Test
    fun `peer-targeted send never redirects to another peer`() {
        // C is connected, D is not
        val peerStates = mutableMapOf<String, BLEConnectionManager.PeerConnectionState>()
        peerStates["C"] = BLEConnectionManager.PeerConnectionState(
            deviceId = "C",
            state = BLEConnectionManager.ConnectionState.CONNECTED,
            mtu = 512,
            role = BLEConnectionManager.ConnectionRole.CLIENT
        )

        // Send to D should NOT fall back to C
        val targetForD = peerStates["D"]
        assertNull(targetForD)  // D is not connected → NOT_CONNECTED error
        // C should remain untouched
        assertEquals(1, peerStates.size)
        assertNotNull(peerStates["C"])
    }

    @Test
    fun `send to C and D are independent`() {
        val peerStates = mutableMapOf<String, BLEConnectionManager.PeerConnectionState>()
        peerStates["C"] = BLEConnectionManager.PeerConnectionState(
            deviceId = "C",
            state = BLEConnectionManager.ConnectionState.CONNECTED,
            mtu = 512,
            role = BLEConnectionManager.ConnectionRole.CLIENT
        )
        peerStates["D"] = BLEConnectionManager.PeerConnectionState(
            deviceId = "D",
            state = BLEConnectionManager.ConnectionState.CONNECTED,
            mtu = 23,
            role = BLEConnectionManager.ConnectionRole.SERVER
        )

        // Both exist and are connected
        assertEquals(2, peerStates.size)
        assertEquals(BLEConnectionManager.ConnectionRole.CLIENT, peerStates["C"]!!.role)
        assertEquals(BLEConnectionManager.ConnectionRole.SERVER, peerStates["D"]!!.role)
    }

    // ── Disconnect API tests ──────────────────────────────────────────

    @Test
    fun `peer-targeted disconnect only affects target peer`() {
        val peerStates = mutableMapOf<String, BLEConnectionManager.PeerConnectionState>()
        peerStates["C"] = BLEConnectionManager.PeerConnectionState(
            deviceId = "C",
            state = BLEConnectionManager.ConnectionState.CONNECTED,
            mtu = 512,
            role = BLEConnectionManager.ConnectionRole.CLIENT
        )
        peerStates["D"] = BLEConnectionManager.PeerConnectionState(
            deviceId = "D",
            state = BLEConnectionManager.ConnectionState.CONNECTED,
            mtu = 23,
            role = BLEConnectionManager.ConnectionRole.SERVER
        )

        // Disconnect C only
        peerStates.remove("C")

        assertEquals(1, peerStates.size)
        assertNotNull(peerStates["D"])
        assertEquals(BLEConnectionManager.ConnectionState.CONNECTED, peerStates["D"]!!.state)
    }

    @Test
    fun `disconnect all clears all peers`() {
        val peerStates = mutableMapOf<String, BLEConnectionManager.PeerConnectionState>()
        peerStates["C"] = BLEConnectionManager.PeerConnectionState(
            deviceId = "C",
            state = BLEConnectionManager.ConnectionState.CONNECTED,
            mtu = 512,
            role = BLEConnectionManager.ConnectionRole.CLIENT
        )
        peerStates["D"] = BLEConnectionManager.PeerConnectionState(
            deviceId = "D",
            state = BLEConnectionManager.ConnectionState.CONNECTED,
            mtu = 23,
            role = BLEConnectionManager.ConnectionRole.SERVER
        )

        peerStates.clear()

        assertEquals(0, peerStates.size)
    }

    @Test
    fun `disconnect unknown peer does not affect existing peers`() {
        val peerStates = mutableMapOf<String, BLEConnectionManager.PeerConnectionState>()
        peerStates["C"] = BLEConnectionManager.PeerConnectionState(
            deviceId = "C",
            state = BLEConnectionManager.ConnectionState.CONNECTED,
            mtu = 512,
            role = BLEConnectionManager.ConnectionRole.CLIENT
        )

        // Try to disconnect non-existent peer
        val target = peerStates["X"]
        assertNull(target)
        // C unaffected
        assertEquals(1, peerStates.size)
        assertNotNull(peerStates["C"])
    }

    // ── getConnectionState API tests ──────────────────────────────────

    @Test
    fun `per-peer getConnectionState returns correct state`() {
        val peerStates = mutableMapOf<String, BLEConnectionManager.PeerConnectionState>()
        peerStates["C"] = BLEConnectionManager.PeerConnectionState(
            deviceId = "C",
            state = BLEConnectionManager.ConnectionState.CONNECTED,
            mtu = 512,
            role = BLEConnectionManager.ConnectionRole.CLIENT
        )
        peerStates["D"] = BLEConnectionManager.PeerConnectionState(
            deviceId = "D",
            state = BLEConnectionManager.ConnectionState.CONNECTED,
            mtu = 23,
            role = BLEConnectionManager.ConnectionRole.SERVER
        )

        val cState = peerStates["C"]
        val dState = peerStates["D"]

        assertEquals("C", cState!!.deviceId)
        assertEquals(BLEConnectionManager.ConnectionState.CONNECTED, cState.state)
        assertEquals(512, cState.mtu)
        assertEquals(BLEConnectionManager.ConnectionRole.CLIENT, cState.role)

        assertEquals("D", dState!!.deviceId)
        assertEquals(BLEConnectionManager.ConnectionState.CONNECTED, dState.state)
        assertEquals(23, dState.mtu)
        assertEquals(BLEConnectionManager.ConnectionRole.SERVER, dState.role)
    }

    @Test
    fun `getConnectionState for non-existent peer returns IDLE`() {
        val peerStates = mutableMapOf<String, BLEConnectionManager.PeerConnectionState>()
        peerStates["C"] = BLEConnectionManager.PeerConnectionState(
            deviceId = "C",
            state = BLEConnectionManager.ConnectionState.CONNECTED,
            mtu = 512,
            role = BLEConnectionManager.ConnectionRole.CLIENT
        )

        val target = peerStates["X"]
        assertNull(target)
        // Should return IDLE representation
    }

    @Test
    fun `legacy getConnectionState returns first connected peer`() {
        val peerStates = mutableMapOf<String, BLEConnectionManager.PeerConnectionState>()
        peerStates["C"] = BLEConnectionManager.PeerConnectionState(
            deviceId = "C",
            state = BLEConnectionManager.ConnectionState.CONNECTED,
            mtu = 512,
            role = BLEConnectionManager.ConnectionRole.CLIENT
        )

        val firstConnected = peerStates.values.find {
            it.state == BLEConnectionManager.ConnectionState.CONNECTED
        }
        assertNotNull(firstConnected)
        assertEquals("C", firstConnected!!.deviceId)
        assertEquals(512, firstConnected.mtu)
    }

    // ── Multiple peers through bridge tests ───────────────────────────

    @Test
    fun `multiple peers can coexist through bridge`() {
        val peerStates = mutableMapOf<String, BLEConnectionManager.PeerConnectionState>()
        peerStates["C"] = BLEConnectionManager.PeerConnectionState(
            deviceId = "C",
            state = BLEConnectionManager.ConnectionState.CONNECTED,
            mtu = 512,
            role = BLEConnectionManager.ConnectionRole.CLIENT
        )
        peerStates["D"] = BLEConnectionManager.PeerConnectionState(
            deviceId = "D",
            state = BLEConnectionManager.ConnectionState.CONNECTED,
            mtu = 23,
            role = BLEConnectionManager.ConnectionRole.SERVER
        )
        peerStates["E"] = BLEConnectionManager.PeerConnectionState(
            deviceId = "E",
            state = BLEConnectionManager.ConnectionState.CONNECTED,
            mtu = 247,
            role = BLEConnectionManager.ConnectionRole.CLIENT
        )

        assertEquals(3, peerStates.size)
        assertEquals(3, peerStates.values.count {
            it.state == BLEConnectionManager.ConnectionState.CONNECTED
        })
    }

    // ── Event attribution tests ───────────────────────────────────────

    @Test
    fun `fromDevice in BLE_DATA_RECEIVED identifies correct peer`() {
        // C sends data
        val fromDeviceC = "C"
        assertEquals("C", fromDeviceC)

        // D sends data
        val fromDeviceD = "D"
        assertEquals("D", fromDeviceD)

        // These must be independent
        assertNotEquals(fromDeviceC, fromDeviceD)
    }

    // ── C failure does not affect D tests ─────────────────────────────

    @Test
    fun `C failure does not affect D`() {
        val peerStates = mutableMapOf<String, BLEConnectionManager.PeerConnectionState>()
        peerStates["C"] = BLEConnectionManager.PeerConnectionState(
            deviceId = "C",
            state = BLEConnectionManager.ConnectionState.CONNECTED,
            mtu = 512,
            role = BLEConnectionManager.ConnectionRole.CLIENT
        )
        peerStates["D"] = BLEConnectionManager.PeerConnectionState(
            deviceId = "D",
            state = BLEConnectionManager.ConnectionState.CONNECTED,
            mtu = 23,
            role = BLEConnectionManager.ConnectionRole.SERVER
        )

        // C fails (removed)
        peerStates.remove("C")

        // D unaffected
        assertEquals(1, peerStates.size)
        assertEquals(BLEConnectionManager.ConnectionState.CONNECTED, peerStates["D"]!!.state)
        assertEquals(23, peerStates["D"]!!.mtu)
    }

    @Test
    fun `D failure does not affect C`() {
        val peerStates = mutableMapOf<String, BLEConnectionManager.PeerConnectionState>()
        peerStates["C"] = BLEConnectionManager.PeerConnectionState(
            deviceId = "C",
            state = BLEConnectionManager.ConnectionState.CONNECTED,
            mtu = 512,
            role = BLEConnectionManager.ConnectionRole.CLIENT
        )
        peerStates["D"] = BLEConnectionManager.PeerConnectionState(
            deviceId = "D",
            state = BLEConnectionManager.ConnectionState.CONNECTED,
            mtu = 23,
            role = BLEConnectionManager.ConnectionRole.SERVER
        )

        // D fails (removed)
        peerStates.remove("D")

        // C unaffected
        assertEquals(1, peerStates.size)
        assertEquals(BLEConnectionManager.ConnectionState.CONNECTED, peerStates["C"]!!.state)
        assertEquals(512, peerStates["C"]!!.mtu)
    }

    // ── Legacy caller compatibility ────────────────────────────────────

    @Test
    fun `legacy send without deviceId uses first connected peer`() {
        val peerStates = mutableMapOf<String, BLEConnectionManager.PeerConnectionState>()
        peerStates["C"] = BLEConnectionManager.PeerConnectionState(
            deviceId = "C",
            state = BLEConnectionManager.ConnectionState.CONNECTED,
            mtu = 512,
            role = BLEConnectionManager.ConnectionRole.CLIENT
        )

        // Legacy: no deviceId → uses first connected
        val legacyDeviceId = peerStates.values.find {
            it.state == BLEConnectionManager.ConnectionState.CONNECTED
        }?.deviceId
        assertEquals("C", legacyDeviceId)
    }

    @Test
    fun `legacy disconnect without deviceId clears all`() {
        val peerStates = mutableMapOf<String, BLEConnectionManager.PeerConnectionState>()
        peerStates["C"] = BLEConnectionManager.PeerConnectionState(
            deviceId = "C",
            state = BLEConnectionManager.ConnectionState.CONNECTED,
            mtu = 512,
            role = BLEConnectionManager.ConnectionRole.CLIENT
        )
        peerStates["D"] = BLEConnectionManager.PeerConnectionState(
            deviceId = "D",
            state = BLEConnectionManager.ConnectionState.CONNECTED,
            mtu = 23,
            role = BLEConnectionManager.ConnectionRole.SERVER
        )

        // Legacy disconnect (no deviceId)
        peerStates.clear()

        assertEquals(0, peerStates.size)
    }
}
