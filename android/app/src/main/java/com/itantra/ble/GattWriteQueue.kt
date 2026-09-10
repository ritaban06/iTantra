package com.itantra.ble

import android.util.Log
import java.util.ArrayDeque
import java.util.HashMap
import java.util.HashSet

/**
 * Per-peer serialized GATT write queue (MVP hardening — Phase 5).
 *
 * Android requires that a new [android.bluetooth.BluetoothGatt.writeCharacteristic]
 * (or GATT-server notification) is not issued for a connection until the previous
 * one completed. Submitting writes back-to-back causes GATT_BUSY failures or
 * silent drops, which breaks V7 fragment ordering for long sentences.
 *
 * This queue serializes writes per connection key (BLE deviceId for client-role
 * writes, remote MAC address for server-role notifications). Each queued write is
 * submitted only after the previous write for the SAME key completed. Different
 * keys have independent queues — A→B traffic never blocks unrelated A→C traffic.
 *
 * Completion is reported through [android.bluetooth.BluetoothGattCallback.onCharacteristicWrite]
 * (client role) or [android.bluetooth.BluetoothGattServerCallback.onNotificationSent]
 * (server role) via [notifyCompleted]. Failure/teardown paths call [clear] so
 * pending callbacks settle with `false` instead of hanging.
 *
 * Thread safety: all state is guarded by the object monitor. GATT callbacks arrive
 * on Binder threads; submissions may come from any thread.
 */
object GattWriteQueue {

    private const val TAG = "GattWriteQueue"

    private class PendingWrite(
        val write: () -> Boolean,
        val callback: ((Boolean) -> Unit)?,
    )

    /** Pending writes per key. The head (if any) is the in-flight write. */
    private val queues = HashMap<String, ArrayDeque<PendingWrite>>()

    /** Keys whose head write was submitted but has not completed yet. */
    private val inFlight = HashSet<String>()

    /**
     * Enqueue a write for the given connection key.
     *
     * If no write is in flight for the key, the head write is submitted
     * synchronously (preserving the previous synchronous submission timing).
     * Otherwise the write is buffered and submitted automatically when the
     * in-flight write completes.
     *
     * @param key      Connection key (client BLE deviceId or server remote MAC).
     * @param write    Suspends-free write submission returning `true` when the
     *                 platform accepted the write (completion comes later).
     * @param callback Optional completion callback — invoked exactly once with
     *                 the actual GATT completion result, or `false` on
     *                 submission failure or teardown.
     * @return `true` if the head write was accepted by the platform at
     *         submission time; `false` if submission failed (the callback is
     *         then invoked with `false` synchronously). Writes buffered behind
     *         an in-flight write also report `true` (accepted for delivery).
     */
    @Synchronized
    fun enqueue(key: String, write: () -> Boolean, callback: ((Boolean) -> Unit)? = null): Boolean {
        val queue = queues.getOrPut(key) { ArrayDeque() }
        val pending = PendingWrite(write, callback)
        queue.addLast(pending)

        if (inFlight.contains(key)) {
            // A previous write is still pending completion — stay buffered.
            return true
        }

        // Submit head synchronously.
        val accepted = submitHead(key)
        if (!accepted) {
            // Submission failed: settle this entry and drain the rest.
            queue.pollFirst()
            settle(pending, false)
            pumpLocked(key)
        }
        return accepted
    }

    /**
     * Report completion of the in-flight write for a key.
     * Invoked from the GATT completion callbacks. Pops the completed entry,
     * invokes its callback, and submits the next queued write (if any).
     *
     * Safe to call when nothing is in flight (e.g. stale callback) — it is a no-op.
     */
    @Synchronized
    fun notifyCompleted(key: String, success: Boolean) {
        val queue = queues[key] ?: return
        if (!inFlight.remove(key)) {
            Log.w(TAG, "Completion for key $key with nothing in flight — ignored")
            return
        }
        val head = queue.pollFirst()
        if (head != null) {
            settle(head, success)
        }
        pumpLocked(key)
    }

    /**
     * Fail and drop all pending writes for a key (disconnect/teardown).
     * Pending completion callbacks settle with `false`.
     */
    @Synchronized
    fun clear(key: String) {
        val queue = queues.remove(key) ?: return
        inFlight.remove(key)
        for (pending in queue) {
            settle(pending, false)
        }
    }

    /** Fail and drop every queued write (global teardown). */
    @Synchronized
    fun clearAll() {
        for (key in queues.keys.toList()) {
            clear(key)
        }
    }

    /** Number of keys with pending or in-flight writes (diagnostics/tests). */
    @Synchronized
    fun activeKeyCount(): Int = queues.size

    /** Number of writes buffered (not yet submitted) for a key (diagnostics/tests). */
    @Synchronized
    fun pendingCount(key: String): Int {
        val queue = queues[key] ?: return 0
        return if (inFlight.contains(key)) queue.size - 1 else queue.size
    }

    /**
     * Submit the head write for a key. Marks it in-flight when accepted.
     * Caller must hold the monitor.
     */
    private fun pumpLocked(key: String) {
        val queue = queues[key]
        if (queue == null || queue.isEmpty()) {
            if (queue != null && queue.isEmpty() && !inFlight.contains(key)) {
                queues.remove(key)
            }
            return
        }
        val accepted = submitHead(key)
        if (!accepted) {
            val head = queue.pollFirst()
            inFlight.remove(key)
            if (head != null) {
                settle(head, false)
            }
            // Continue draining — failures never stall subsequent writes.
            pumpLocked(key)
        }
    }

    /** Submit the current head write and mark it in-flight when accepted. */
    private fun submitHead(key: String): Boolean {
        val queue = queues[key] ?: return false
        val head = queue.peekFirst() ?: return false
        val accepted = try {
            head.write()
        } catch (e: Exception) {
            Log.w(TAG, "Write submission threw for key $key: ${e.message}")
            false
        }
        if (accepted) {
            inFlight.add(key)
        }
        return accepted
    }

    /** Invoke a completion callback, isolating callback exceptions. */
    private fun settle(pending: PendingWrite, success: Boolean) {
        try {
            pending.callback?.invoke(success)
        } catch (e: Exception) {
            Log.w(TAG, "Write completion callback threw: ${e.message}")
        }
    }
}
