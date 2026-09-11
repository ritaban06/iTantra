package com.itantra.ble

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerConnectionGuardTest {

    @Test
    fun `late disconnect cannot remove a reconnected same-address peer`() {
        val guard = ServerConnectionGuard()
        val generationA = Any()
        val generationB = Any()

        val a = guard.markConnected("4C:C0:6B:9F:50:68", generationA)
        val b = guard.markConnected("4c:c0:6b:9f:50:68", generationB)
        assertTrue(b > a)

        // A's delayed callback must be ignored without any platform-state
        // assumption. B remains the active generation.
        assertFalse(guard.processDisconnect("4C:C0:6B:9F:50:68", generationA) != null)

        // B's own callback still removes exactly B.
        assertEquals(b, guard.processDisconnect("4C:C0:6B:9F:50:68", generationB))
    }

    @Test
    fun `duplicate disconnect is ignored after current peer is removed`() {
        val guard = ServerConnectionGuard()
        val callback = Any()
        guard.markConnected("AA:BB:CC:DD:EE:FF", callback)

        assertNotNull(guard.processDisconnect("AA:BB:CC:DD:EE:FF", callback))
        assertNull(guard.processDisconnect("AA:BB:CC:DD:EE:FF", callback))
    }
}
