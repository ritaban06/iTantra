package com.itantra.ble

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Bridges an asynchronous Android GATT callback to the existing synchronous
 * String? send contract. `null` is a completed success, distinct from a
 * callback that has not arrived before the timeout.
 */
internal class GattOperationCompletion {
    private val latch = CountDownLatch(1)

    @Volatile
    private var completed = false

    @Volatile
    private var error: String? = null

    fun complete(success: Boolean, failure: String) {
        error = if (success) null else failure
        completed = true
        latch.countDown()
    }

    fun await(timeoutSeconds: Long, timeoutError: String): String? = try {
        if (!latch.await(timeoutSeconds, TimeUnit.SECONDS) || !completed) {
            timeoutError
        } else {
            error
        }
    } catch (_: InterruptedException) {
        timeoutError
    }
}
