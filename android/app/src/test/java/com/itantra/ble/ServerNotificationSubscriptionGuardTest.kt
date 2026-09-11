package com.itantra.ble

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerNotificationSubscriptionGuardTest {
    @Test
    fun `a new or reconnected client is not notification ready until it subscribes`() {
        val guard = ServerNotificationSubscriptionGuard()

        guard.markConnected("AA:BB:CC:DD:EE:FF")
        assertFalse(guard.isEnabled("aa:bb:cc:dd:ee:ff"))

        assertTrue(guard.setEnabled("aa:bb:cc:dd:ee:ff", true))
        assertTrue(guard.isEnabled("AA:BB:CC:DD:EE:FF"))
        assertFalse(guard.setEnabled("AA:BB:CC:DD:EE:FF", true))

        guard.markConnected("AA:BB:CC:DD:EE:FF")
        assertFalse(guard.isEnabled("AA:BB:CC:DD:EE:FF"))
    }

    @Test
    fun `disable disconnect and clear revoke notification readiness`() {
        val guard = ServerNotificationSubscriptionGuard()
        guard.markConnected("AA:BB:CC:DD:EE:FF")
        guard.setEnabled("AA:BB:CC:DD:EE:FF", true)

        assertFalse(guard.setEnabled("AA:BB:CC:DD:EE:FF", false))
        assertFalse(guard.isEnabled("AA:BB:CC:DD:EE:FF"))

        guard.setEnabled("AA:BB:CC:DD:EE:FF", true)
        guard.remove("AA:BB:CC:DD:EE:FF")
        assertFalse(guard.isEnabled("AA:BB:CC:DD:EE:FF"))

        guard.setEnabled("AA:BB:CC:DD:EE:FF", true)
        guard.clear()
        assertFalse(guard.isEnabled("AA:BB:CC:DD:EE:FF"))
    }
}
