package com.itantra.ble

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class GattOperationCompletionTest {
    @Test
    fun `a successful callback returns success rather than a timeout`() {
        val completion = GattOperationCompletion()
        completion.complete(success = true, failure = "NOTIFY_FAILED")

        assertNull(completion.await(1, "NOTIFY_TIMEOUT"))
    }

    @Test
    fun `a failed callback returns its operation failure`() {
        val completion = GattOperationCompletion()
        completion.complete(success = false, failure = "WRITE_FAILED")

        assertEquals("WRITE_FAILED", completion.await(1, "WRITE_TIMEOUT"))
    }

    @Test
    fun `no callback returns the timeout`() {
        val completion = GattOperationCompletion()

        assertEquals("NOTIFY_TIMEOUT", completion.await(0, "NOTIFY_TIMEOUT"))
    }
}
