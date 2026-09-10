package com.itantra.ble

import org.junit.Assert.*
import org.junit.Test

/**
 * Unit tests for the per-peer serialized GATT write queue (MVP hardening Phase 5).
 *
 * Pure JVM tests — no Android Bluetooth runtime required. The queue's
 * write lambdas are fakes returning true/false; completion is driven
 * manually via notifyCompleted(), mirroring the GATT callback flow.
 */
class GattWriteQueueTest {

    private fun freshKey(): String = "test-${System.nanoTime()}"

    @Test
    fun `head write is submitted synchronously when nothing is in flight`() {
        val key = freshKey()
        var submitted = false
        val accepted = GattWriteQueue.enqueue(key, { submitted = true; true }, null)
        assertTrue(accepted)
        assertTrue(submitted)
        GattWriteQueue.notifyCompleted(key, true)
        GattWriteQueue.clear(key)
    }

    @Test
    fun `second write stays buffered until first completes`() {
        val key = freshKey()
        val submitted = mutableListOf<Int>()

        GattWriteQueue.enqueue(key, { submitted.add(1); true }, null)
        GattWriteQueue.enqueue(key, { submitted.add(2); true }, null)

        // Only the first write was submitted so far.
        assertEquals(listOf(1), submitted)
        assertEquals(1, GattWriteQueue.pendingCount(key))

        // Completing the first write submits the second.
        GattWriteQueue.notifyCompleted(key, true)
        assertEquals(listOf(1, 2), submitted)
        GattWriteQueue.notifyCompleted(key, true)
        GattWriteQueue.clear(key)
    }

    @Test
    fun `fragment order is preserved across queued writes`() {
        val key = freshKey()
        val order = mutableListOf<Int>()

        for (i in 1..5) {
            GattWriteQueue.enqueue(key, { order.add(i); true }, null)
        }
        // Drain: complete each in-flight write in sequence.
        repeat(5) { GattWriteQueue.notifyCompleted(key, true) }

        assertEquals(listOf(1, 2, 3, 4, 5), order)
        GattWriteQueue.clear(key)
    }

    @Test
    fun `completion failure propagates to callback and does not stall the queue`() {
        val key = freshKey()
        val results = mutableListOf<Boolean>()
        val submitted = mutableListOf<Int>()

        GattWriteQueue.enqueue(key, { submitted.add(1); true }) { results.add(it) }
        GattWriteQueue.enqueue(key, { submitted.add(2); true }) { results.add(it) }

        // First write completes with failure.
        GattWriteQueue.notifyCompleted(key, false)
        // The first callback failed, the second was still submitted.
        assertEquals(listOf(false), results)
        assertEquals(listOf(1, 2), submitted)

        GattWriteQueue.notifyCompleted(key, true)
        assertEquals(listOf(false, true), results)
        GattWriteQueue.clear(key)
    }

    @Test
    fun `failed submission settles callback immediately and drains next write`() {
        val key = freshKey()
        val results = mutableListOf<Boolean>()
        val submitted = mutableListOf<Int>()

        // First write fails at submission (write() returns false).
        GattWriteQueue.enqueue(key, { false }) { results.add(it) }
        // Second write should be attempted despite the first failing.
        GattWriteQueue.enqueue(key, { submitted.add(2); true }) { results.add(it) }

        assertEquals(listOf(2), submitted)
        assertEquals(listOf(false), results)

        GattWriteQueue.notifyCompleted(key, true)
        assertEquals(listOf(false, true), results)
        GattWriteQueue.clear(key)
    }

    @Test
    fun `clear settles all pending writes with false`() {
        val key = freshKey()
        val results = mutableListOf<Boolean>()

        GattWriteQueue.enqueue(key, { true }) { results.add(it) }
        GattWriteQueue.enqueue(key, { true }) { results.add(it) }
        GattWriteQueue.enqueue(key, { true }) { results.add(it) }

        GattWriteQueue.clear(key)

        // All three writes (1 in-flight + 2 buffered) settled as failed.
        assertEquals(listOf(false, false, false), results)
        assertEquals(0, GattWriteQueue.pendingCount(key))
    }

    @Test
    fun `different keys have independent queues`() {
        val keyA = freshKey()
        val keyB = freshKey()
        val submittedA = mutableListOf<Int>()
        val submittedB = mutableListOf<Int>()

        GattWriteQueue.enqueue(keyA, { submittedA.add(1); true }, null)
        GattWriteQueue.enqueue(keyB, { submittedB.add(1); true }, null)
        // A's second write must not block B's first.
        GattWriteQueue.enqueue(keyA, { submittedA.add(2); true }, null)
        GattWriteQueue.enqueue(keyB, { submittedB.add(2); true }, null)

        assertEquals(listOf(1), submittedA)
        assertEquals(listOf(1), submittedB)

        // Completing A's writes never touches B's queue.
        GattWriteQueue.notifyCompleted(keyA, true)
        GattWriteQueue.notifyCompleted(keyA, true)
        assertEquals(listOf(1, 2), submittedA)
        assertEquals(listOf(1), submittedB)

        GattWriteQueue.notifyCompleted(keyB, true)
        GattWriteQueue.notifyCompleted(keyB, true)
        assertEquals(listOf(1, 2), submittedB)

        GattWriteQueue.clear(keyA)
        GattWriteQueue.clear(keyB)
    }

    @Test
    fun `notifyCompleted with nothing in flight is a safe no-op`() {
        val key = freshKey()
        // Must not throw.
        GattWriteQueue.notifyCompleted(key, true)
        GattWriteQueue.clear(key)
    }

    @Test
    fun `double completion does not double-settle callbacks`() {
        val key = freshKey()
        val results = mutableListOf<Boolean>()
        GattWriteQueue.enqueue(key, { true }) { results.add(it) }
        GattWriteQueue.notifyCompleted(key, true)
        GattWriteQueue.notifyCompleted(key, true) // stale — ignored
        assertEquals(listOf(true), results)
        GattWriteQueue.clear(key)
    }
}
