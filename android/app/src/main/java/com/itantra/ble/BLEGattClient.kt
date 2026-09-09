package com.itantra.ble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.os.Build
import android.util.Log
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

/**
 * GATT client that connects to one or more remote iTantra devices.
 *
 * V9E Step 2: Multi-peer GATT client.
 *
 * Each outgoing BLE connection is tracked independently in [connections],
 * keyed by iTantra device ID. Each connection has its own BluetoothGatt,
 * TX characteristic, MTU, and callback instance.
 *
 * The [Listener] interface is preserved for backward compatibility with
 * BLEConnectionManager. Error/data events use the current single-peer
 * callback signatures.
 *
 * Thread safety: [connections] is accessed via synchronized blocks.
 * Each BluetoothGattCallback is bound to a specific PeerGattConnection
 * via a generation counter, preventing stale callbacks from corrupting
 * newer connections to the same deviceId.
 */
class BLEGattClient(private val context: Context) {

    companion object {
        private const val TAG = "BLEGattClient"
        private const val REQUEST_MTU = 512
    }

    // ── Peer connection data model ────────────────────────────────────

    /**
     * Per-peer GATT connection state.
     *
     * Each connected/connected peer gets its own instance. Fields are
     * mutated only from Android callback threads or synchronized public
     * methods — no external locking is needed for individual BLE
     * operations since Android serializes per-BluetoothGatt.
     */
    data class PeerGattConnection(
        val deviceId: String,
        var gatt: BluetoothGatt? = null,
        var txCharacteristic: BluetoothGattCharacteristic? = null,
        @Volatile var isConnected: Boolean = false,
        @Volatile var mtu: Int = 23,
        val callback: BluetoothGattCallback,
        /** Monotonically increasing ID to detect stale callbacks. */
        val generation: Long,
        /** Serialized write queue for this peer's GATT connection. */
        val writeQueue: GattWriteQueueFacade = GattWriteQueueFacade()
    )

    /**
     * Thin facade over [GattWriteQueue] bound to one peer. Exposes a
     * promise-style send that completes when the Android GATT write actually
     * completes (not merely when it was accepted).
     */
    class GattWriteQueueFacade {

        /** Result of a fully-completed write: null = success, else error string. */
        fun enqueueWrite(write: () -> Boolean, onDone: (String?) -> Unit) {
            GattWriteQueue.enqueue(key, write) { success ->
                onDone(if (success) null else "WRITE_FAILED")
            }
        }

        /** Report completion of the in-flight write (from the GATT callback). */
        fun notifyCompleted(success: Boolean) {
            GattWriteQueue.notifyCompleted(key, success)
        }

        /** Fail all pending writes for this peer (disconnect/teardown). */
        fun clear() {
            GattWriteQueue.clear(key)
        }

        private val key: String = "client-${System.identityHashCode(this)}"
    }

    // ── Listener (preserved for backward compatibility) ────────────────

    interface Listener {
        fun onConnected(deviceId: String, mtu: Int)
        fun onDisconnected(deviceId: String, reason: String)
        fun onDataReceived(deviceId: String, data: ByteArray)
        fun onError(deviceId: String?, code: String, message: String)
    }

    // ── Internal state ────────────────────────────────────────────────

    private val bluetoothManager: BluetoothManager? =
        context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager

    /** Per-peer connections, keyed by iTantra device ID. Thread-safe access. */
    private val connections = mutableMapOf<String, PeerGattConnection>()

    /** Generation counter for stale callback detection. Incremented on each new connection per deviceId. */
    private val generationCounter = AtomicLong(1)

    var listener: Listener? = null

    // ── Legacy single-peer properties (backward compatibility) ─────────
    //
    // These are synchronized with the primary connected peer's state.
    // NOT the source of truth — [connections] is.

    /** Whether any peer is currently connected (reflects first connected peer). */
    @Volatile
    var isConnected: Boolean = false
        private set

    /** MTU of the first connected peer (for backward compatibility). */
    @Volatile
    var mtu: Int = 23
        private set

    // ── Per-peer accessors ────────────────────────────────────────────

    /** Get the number of active connections. */
    val connectionCount: Int
        get() = synchronized(connections) { connections.size }

    /** Check if a specific peer is connected. */
    fun isConnectedTo(deviceId: String): Boolean {
        return synchronized(connections) {
            connections[deviceId]?.isConnected == true
        }
    }

    /** Get the MTU for a specific peer. */
    fun getMtu(deviceId: String): Int {
        return synchronized(connections) {
            connections[deviceId]?.mtu ?: 23
        }
    }

    /** Get all connected device IDs. */
    fun getConnectedDeviceIds(): List<String> {
        return synchronized(connections) {
            connections.values.filter { it.isConnected }.map { it.deviceId }
        }
    }

    // ── Connect ───────────────────────────────────────────────────────

    /**
     * Connect to a remote BluetoothDevice.
     *
     * Multiple simultaneous connections are supported. A second connection
     * attempt for a DIFFERENT device creates an independent GATT connection.
     * A duplicate connection attempt for the SAME device is safely ignored.
     *
     * @param device The Android BluetoothDevice to connect to.
     * @param deviceId The iTantra device ID for event reporting and state tracking.
     */
    @SuppressLint("MissingPermission")
    fun connect(device: BluetoothDevice, deviceId: String) {
        synchronized(connections) {
            // If this deviceId already has an active/connecting connection, ignore.
            val existing = connections[deviceId]
            if (existing != null && (existing.isConnected || existing.gatt != null)) {
                Log.w(TAG, "Already connected or connecting to $deviceId, ignoring")
                return
            }

            val generation = generationCounter.incrementAndGet()
            val callback = createPeerCallback(deviceId, generation)
            val peerConnection = PeerGattConnection(
                deviceId = deviceId,
                generation = generation,
                callback = callback
            )

            Log.d(TAG, "Connecting to $deviceId (${device.address}) [gen=$generation]")

            val gatt = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                device.connectGatt(context, false, peerConnection.callback, BluetoothDevice.TRANSPORT_LE)
            } else {
                @Suppress("DEPRECATION")
                device.connectGatt(context, false, peerConnection.callback)
            }

            peerConnection.gatt = gatt
            connections[deviceId] = peerConnection
        }
    }

    // ── Disconnect per-peer ───────────────────────────────────────────

    /**
     * Disconnect and close a specific peer's GATT connection.
     *
     * Other peers are not affected.
     *
     * @param deviceId The peer to disconnect.
     */
    @SuppressLint("MissingPermission")
    fun disconnect(deviceId: String) {
        val peer = synchronized(connections) { connections[deviceId] } ?: return

        try {
            peer.gatt?.let { gatt ->
                if (peer.isConnected) {
                    gatt.disconnect()
                }
                gatt.close()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error disconnecting $deviceId: ${e.message}")
        } finally {
            // Fail any queued writes for this peer — pending send promises
            // settle with WRITE_FAILED instead of timing out.
            peer.writeQueue.clear()
            synchronized(connections) {
                connections.remove(deviceId)
            }
            // Synchronize legacy property if this was the primary peer
            syncLegacyState()
        }
    }

    /**
     * Disconnect all peers. Used for lifecycle cleanup.
     */
    @SuppressLint("MissingPermission")
    fun disconnect() {
        val peers: List<PeerGattConnection>
        synchronized(connections) {
            peers = connections.values.toList()
            connections.clear()
        }

        for (peer in peers) {
            try {
                peer.gatt?.let { gatt ->
                    if (peer.isConnected) {
                        gatt.disconnect()
                    }
                    gatt.close()
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error disconnecting ${peer.deviceId}: ${e.message}")
            }
        }

        // Reset legacy state
        synchronized(connections) {
            isConnected = false
            mtu = 23
        }
    }

    // ── Send to specific peer ─────────────────────────────────────────

    /**
     * Send data to a specific peer via that peer's TX characteristic.
     *
     * @param data The bytes to send.
     * @param deviceId The target peer.
     * @return null on success, or an error string.
     */
    @SuppressLint("MissingPermission")
    fun send(data: ByteArray, deviceId: String): String? {
        val peer = synchronized(connections) { connections[deviceId] }
            ?: return "NOT_CONNECTED"
        if (!peer.isConnected) return "NOT_CONNECTED"

        val gatt = peer.gatt ?: return "NOT_CONNECTED"
        val char = peer.txCharacteristic ?: return "TX_CHARACTERISTIC_NOT_FOUND"

        // Enqueue the write — the queue serializes per peer and the returned
        // promise completes on the actual onCharacteristicWrite callback, so
        // fragment N+1 is never submitted before fragment N completed.
        var submissionError: String? = null
        val latch = java.util.concurrent.CountDownLatch(1)
        peer.writeQueue.enqueueWrite(
            write = {
                char.value = data
                gatt.writeCharacteristic(char)
            },
            onDone = { error ->
                submissionError = error
                latch.countDown()
            },
        )
        // GATT completion arrives on a Binder thread; wait for it so the
        // synchronous String? contract with BLEModule is preserved.
        return try {
            latch.await(10, java.util.concurrent.TimeUnit.SECONDS)
            submissionError ?: "WRITE_TIMEOUT"
        } catch (_: InterruptedException) {
            "WRITE_TIMEOUT"
        }
    }

    /**
     * Send data to the first connected peer (backward-compatible single-peer API).
     *
     * @param data The bytes to send.
     * @return null on success, or an error string.
     */
    @SuppressLint("MissingPermission")
    fun send(data: ByteArray): String? {
        val peerId = synchronized(connections) {
            connections.values.find { it.isConnected }?.deviceId
        } ?: return "NOT_CONNECTED"
        return send(data, peerId)
    }

    // ── MTU request ───────────────────────────────────────────────────

    /**
     * Request a larger MTU for a specific peer.
     */
    @SuppressLint("MissingPermission")
    fun requestMtu(mtuSize: Int = REQUEST_MTU, deviceId: String) {
        val peer = synchronized(connections) { connections[deviceId] }
        peer?.gatt?.requestMtu(mtuSize)
    }

    /**
     * Request a larger MTU for the first connected peer (backward-compatible).
     */
    @SuppressLint("MissingPermission")
    fun requestMtu(mtuSize: Int = REQUEST_MTU) {
        val peerId = synchronized(connections) {
            connections.values.find { it.isConnected }?.deviceId
        } ?: return
        requestMtu(mtuSize, peerId)
    }

    // ── Stale callback detection ──────────────────────────────────────

    /**
     * Check whether a callback's generation matches the current connection
     * for the given deviceId. Returns the PeerGattConnection if valid,
     * null if stale.
     */
    private fun validateCallback(deviceId: String, callbackGeneration: Long): PeerGattConnection? {
        return synchronized(connections) {
            val peer = connections[deviceId]
            if (peer != null && peer.generation == callbackGeneration) {
                peer
            } else {
                if (peer != null) {
                    Log.w(TAG, "Stale callback for $deviceId (callback gen=$callbackGeneration, current gen=${peer.generation})")
                }
                null
            }
        }
    }

    // ── Legacy state synchronization ──────────────────────────────────

    /**
     * Synchronize legacy single-peer properties from [connections].
     * Reflects the first connected peer for backward compatibility.
     */
    private fun syncLegacyState() {
        synchronized(connections) {
            val firstConnected = connections.values.find { it.isConnected }
            if (firstConnected != null) {
                isConnected = true
                mtu = firstConnected.mtu
            } else {
                isConnected = false
            }
        }
    }

    // ── Per-peer GATT callback factory ────────────────────────────────

    /**
     * Create a GATT callback bound to a specific PeerGattConnection.
     *
     * Each callback captures its deviceId and generation, so it can
     * validate itself against the current connection state before
     * mutating shared state. This prevents stale callbacks from
     * corrupting newer connections to the same deviceId.
     */
    private fun createPeerCallback(deviceId: String, generation: Long): BluetoothGattCallback {
        return object : BluetoothGattCallback() {

            @SuppressLint("MissingPermission")
            override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
                val peer = validateCallback(deviceId, generation) ?: return

                when (newState) {
                    BluetoothProfile.STATE_CONNECTED -> {
                        Log.d(TAG, "Connected to $deviceId, discovering services... [gen=$generation]")
                        gatt.requestMtu(REQUEST_MTU)
                    }
                    BluetoothProfile.STATE_DISCONNECTED -> {
                        peer.isConnected = false
                        // Settle queued writes so no send promise hangs on a dead link.
                        peer.writeQueue.clear()
                        val reason = if (status == BluetoothGatt.GATT_SUCCESS) "LOCAL" else "ERROR($status)"
                        Log.d(TAG, "Disconnected from $deviceId: $reason [gen=$generation]")
                        listener?.onDisconnected(deviceId, reason)
                        try { gatt.close() } catch (_: Exception) {}
                        synchronized(connections) {
                            // Only remove if this is still the active connection for this deviceId
                            val current = connections[deviceId]
                            if (current != null && current.generation == generation) {
                                connections.remove(deviceId)
                            }
                        }
                        syncLegacyState()
                    }
                }
            }

            @SuppressLint("MissingPermission")
            override fun onMtuChanged(gatt: BluetoothGatt, mtuValue: Int, status: Int) {
                val peer = validateCallback(deviceId, generation) ?: return

                if (status == BluetoothGatt.GATT_SUCCESS) {
                    peer.mtu = mtuValue
                    Log.d(TAG, "MTU negotiated for $deviceId: $mtuValue [gen=$generation]")
                    syncLegacyState()
                }
                // Proceed with service discovery regardless of MTU result.
                gatt.discoverServices()
            }

            @SuppressLint("MissingPermission")
            override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
                val peer = validateCallback(deviceId, generation) ?: return

                if (status != BluetoothGatt.GATT_SUCCESS) {
                    listener?.onError(deviceId, "SERVICE_DISCOVERY_FAILED", "Service discovery failed for $deviceId: $status")
                    return
                }

                // Locate the iTantra service.
                val service = gatt.getService(BLEConstants.SERVICE_UUID)
                if (service == null) {
                    listener?.onError(deviceId, "SERVICE_NOT_FOUND", "iTantra service not found on $deviceId")
                    gatt.disconnect()
                    return
                }

                // Locate TX characteristic (for sending data).
                peer.txCharacteristic = service.getCharacteristic(BLEConstants.TX_CHAR_UUID)
                if (peer.txCharacteristic == null) {
                    listener?.onError(deviceId, "TX_NOT_FOUND", "TX characteristic not found on $deviceId")
                    gatt.disconnect()
                    return
                }

                // Locate RX characteristic and enable notifications.
                val rxChar = service.getCharacteristic(BLEConstants.RX_CHAR_UUID)
                if (rxChar == null) {
                    listener?.onError(deviceId, "RX_NOT_FOUND", "RX characteristic not found on $deviceId")
                    gatt.disconnect()
                    return
                }

                // Enable notifications on RX.
                gatt.setCharacteristicNotification(rxChar, true)
                val descriptor = rxChar.getDescriptor(BLEConstants.CCCD_UUID)
                if (descriptor != null) {
                    descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                    gatt.writeDescriptor(descriptor)
                } else {
                    // CCCD not found — still connected, but notifications won't work.
                    Log.w(TAG, "CCCD descriptor not found on RX characteristic for $deviceId")
                    peer.isConnected = true
                    syncLegacyState()
                    listener?.onConnected(deviceId, peer.mtu)
                }
            }

            override fun onCharacteristicWrite(
                gatt: BluetoothGatt,
                characteristic: BluetoothGattCharacteristic,
                status: Int
            ) {
                val peer = validateCallback(deviceId, generation) ?: return

                // Drive the per-peer write queue: the next queued write (if any)
                // is only submitted after this completion.
                peer.writeQueue.notifyCompleted(status == BluetoothGatt.GATT_SUCCESS)

                if (status != BluetoothGatt.GATT_SUCCESS) {
                    listener?.onError(deviceId, "WRITE_FAILED", "Characteristic write failed for $deviceId: $status")
                }
            }

            override fun onCharacteristicChanged(
                gatt: BluetoothGatt,
                characteristic: BluetoothGattCharacteristic
            ) {
                val peer = validateCallback(deviceId, generation) ?: return

                if (characteristic.uuid == BLEConstants.RX_CHAR_UUID) {
                    val data = characteristic.value
                    if (data != null && data.isNotEmpty()) {
                        listener?.onDataReceived(deviceId, data)
                    }
                }
            }

            override fun onDescriptorWrite(
                gatt: BluetoothGatt,
                descriptor: BluetoothGattDescriptor,
                status: Int
            ) {
                val peer = validateCallback(deviceId, generation) ?: return

                if (descriptor.characteristic?.uuid == BLEConstants.RX_CHAR_UUID) {
                    if (status == BluetoothGatt.GATT_SUCCESS) {
                        // Notifications enabled — connection is fully established.
                        peer.isConnected = true
                        Log.d(TAG, "Notifications enabled, connection ready to $deviceId [gen=$generation]")
                        syncLegacyState()
                        listener?.onConnected(deviceId, peer.mtu)
                    } else {
                        listener?.onError(deviceId, "NOTIFICATION_ENABLE_FAILED", "Failed to enable notifications for $deviceId: $status")
                        gatt.disconnect()
                    }
                }
            }
        }
    }
}
