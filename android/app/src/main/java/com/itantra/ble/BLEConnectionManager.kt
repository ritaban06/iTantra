package com.itantra.ble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.content.Context
import android.util.Log

/**
 * Coordinates the BLE subsystems: advertiser, scanner, GATT server, and GATT client.
 *
 * The phone can advertise + run GATT server simultaneously while also scanning
 * and acting as a GATT client — enabling symmetric peer-to-peer discovery and connection.
 *
 * V9E Step 1: Per-peer connection state model.
 *
 * The source of truth for connection state is [peerStates], a map keyed by iTantra device ID.
 * Legacy properties ([connectedDeviceId], [connectionState], [mtu]) are retained for backward
 * compatibility and reflect the first/primary connected peer.
 */
class BLEConnectionManager(private val context: Context) {

    companion object {
        private const val TAG = "BLEConnManager"
    }

    enum class ConnectionState {
        IDLE, SCANNING, CONNECTING, CONNECTED, DISCONNECTING
    }

    /**
     * Whether this peer connection was initiated locally (CLIENT)
     * or accepted from a remote device (SERVER).
     */
    enum class ConnectionRole {
        CLIENT, SERVER
    }

    /**
     * Per-peer connection state.
     *
     * Each BLE peer (identified by iTantra device ID) has its own independent
     * connection state, MTU, and role. Updating one peer's state must never
     * affect another peer's state.
     */
    data class PeerConnectionState(
        val deviceId: String,
        var state: ConnectionState,
        var mtu: Int,
        val role: ConnectionRole
    )

    interface Listener {
        fun onConnectionStateChange(state: ConnectionState, deviceId: String?, mtu: Int?)
        fun onDataReceived(data: ByteArray, fromDevice: String)
        fun onDeviceFound(deviceId: String, name: String?, rssi: Int)
        fun onScanError(code: String, message: String)
        fun onConnectionError(code: String, message: String)
    }

    // ── Multi-peer send/disconnect API ────────────────────────────────

    /**
     * Send data to a specific peer, routing based on connection role.
     *
     * For CLIENT peers: routes through BLEGattClient.send(data, deviceId).
     * For SERVER peers: routes through BLEGattServer.sendNotification(data, device).
     *
     * @return null on success, or an error string.
     */
    fun send(data: ByteArray, deviceId: String): String? {
        val peerState = peerStates[deviceId]
            ?: return "NOT_CONNECTED"

        return when (peerState.role) {
            ConnectionRole.CLIENT -> {
                gattClient.send(data, deviceId)
            }
            ConnectionRole.SERVER -> {
                val btDevice = deviceMap[deviceId]
                    ?: bluetoothManager?.adapter?.getRemoteDevice(
                        peerState.deviceId
                    )
                if (btDevice != null && gattServer.isRunning) {
                    gattServer.sendNotification(data, btDevice)
                } else {
                    "NOT_CONNECTED"
                }
            }
        }
    }

    /**
     * Disconnect a specific peer.
     *
     * For CLIENT peers: disconnects via BLEGattClient.
     * For SERVER peers: cancels the connection via GATT server.
     *
     * An explicit CLIENT-role disconnect emits BLE_DISCONNECTED (via the
     * Listener → IDLE state change) because BLEGattClient removes the GATT
     * connection entry synchronously, which suppresses the later Android
     * DISCONNECTED callback through the stale-callback guard. Without this,
     * JS cleanup (per-peer V8 state, BITCHAT peer registry, announced set)
     * would never run. SERVER-role peers already emit via the platform GATT
     * server callback, so they are not emitted here — exactly one event per
     * peer either way.
     */
    fun disconnect(deviceId: String) {
        val peerState = peerStates[deviceId] ?: return

        when (peerState.role) {
            ConnectionRole.CLIENT -> {
                gattClient.disconnect(deviceId)
            }
            ConnectionRole.SERVER -> {
                val btDevice = deviceMap[deviceId]
                if (btDevice != null) {
                    gattServer.cancelConnection(btDevice)
                }
            }
        }
        removePeerState(deviceId)
        syncLegacyState()

        if (peerState.role == ConnectionRole.CLIENT) {
            listener?.onConnectionStateChange(ConnectionState.IDLE, deviceId, null)
        }
    }

    /**
     * Disconnect all peers.
     */
    fun disconnectAll() {
        // Capture CLIENT-role peer IDs before clearing: gattClient.disconnect()
        // removes their GATT entries synchronously, which suppresses the later
        // Android callbacks, so their disconnect events are emitted below.
        val clientIds = peerStates.values
            .filter { it.role == ConnectionRole.CLIENT }
            .map { it.deviceId }
        // Disconnect all GATT client peers
        gattClient.disconnect()
        // Disconnect all GATT server peers
        val serverPeers = peerStates.values.filter { it.role == ConnectionRole.SERVER }
        for (peer in serverPeers) {
            val btDevice = deviceMap[peer.deviceId]
            if (btDevice != null) {
                gattServer.cancelConnection(btDevice)
            }
        }
        peerStates.clear()
        syncLegacyState()
        // Emit one disconnect event per affected CLIENT-role peer (SERVER-role
        // peers emit via their platform GATT server callbacks).
        clientIds.forEach { deviceId ->
            listener?.onConnectionStateChange(ConnectionState.IDLE, deviceId, null)
        }
    }

    /**
     * Check if a specific peer is connected.
     */
    fun isConnectedTo(deviceId: String): Boolean {
        return peerStates[deviceId]?.state == ConnectionState.CONNECTED
    }

    /**
     * Get the number of connected peers.
     */
    val connectedPeerCount: Int
        get() = peerStates.values.count { it.state == ConnectionState.CONNECTED }

    /**
     * Get all connected peer device IDs.
     */
    fun getConnectedDeviceIds(): List<String> {
        return peerStates.values
            .filter { it.state == ConnectionState.CONNECTED }
            .map { it.deviceId }
    }

    private val bluetoothManager: BluetoothManager? =
        context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager

    val advertiser = BLEAdvertiser(context)
    val scanner = BLEScanner(context)
    val gattServer = BLEGattServer(context)
    val gattClient = BLEGattClient(context)

    var listener: Listener? = null

    /** Map from iTantra device ID → Android BluetoothDevice (populated during scanning). */
    private val deviceMap = mutableMapOf<String, BluetoothDevice>()

    // ── Per-peer state (source of truth) ─────────────────────────────

    /**
     * Per-peer connection state map, keyed by iTantra device ID.
     *
     * This is the authoritative source of truth for connection state.
     * Each entry is independent — updating one peer never affects another.
     */
    val peerStates = mutableMapOf<String, PeerConnectionState>()

    // ── Legacy single-peer properties (backward compatibility) ───────
    //
    // These are retained so existing code that reads them continues to work.
    // They reflect the first/primary connected peer. They are NOT the source
    // of truth — [peerStates] is.

    @Volatile
    var connectionState: ConnectionState = ConnectionState.IDLE
        private set

    @Volatile
    var connectedDeviceId: String? = null
        private set

    @Volatile
    var mtu: Int = 23
        private set

    init {
        // Scanner delivers discovered devices to us.
        scanner.listener = object : BLEScanner.ScanListener {
            override fun onDeviceFound(deviceId: String, name: String?, rssi: Int) {
                // We need the actual BluetoothDevice to connect later.
                // Extract it from the most recent scan result.
                listener?.onDeviceFound(deviceId, name, rssi)
            }

            override fun onDeviceDiscovered(deviceId: String, device: BluetoothDevice) {
                deviceMap[deviceId] = device
            }

            override fun onScanError(code: String, message: String) {
                listener?.onScanError(code, message)
            }
        }

        // GATT server events.
        gattServer.listener = object : BLEGattServer.Listener {
            override fun onClientConnected(device: BluetoothDevice) {
                Log.d(TAG, "GATT server: client connected ${device.address}")
                val fromDeviceId = findDeviceIdByAddress(device.address) ?: device.address
                updatePeerState(fromDeviceId, ConnectionState.CONNECTED, mtu, ConnectionRole.SERVER)
                listener?.onConnectionStateChange(ConnectionState.CONNECTED, fromDeviceId, mtu)
            }

            override fun onClientDisconnected(device: BluetoothDevice) {
                Log.d(TAG, "GATT server: client disconnected ${device.address}")
                val fromDeviceId = findDeviceIdByAddress(device.address) ?: device.address
                removePeerState(fromDeviceId)
                // Legacy: only clear global state if no other peers remain connected
                syncLegacyState()
                listener?.onConnectionStateChange(ConnectionState.IDLE, fromDeviceId, mtu)
            }

            override fun onDataReceived(data: ByteArray, device: BluetoothDevice) {
                // Data received from a connected client (this phone is server role).
                val fromDeviceId = findDeviceIdByAddress(device.address) ?: device.address
                listener?.onDataReceived(data, fromDeviceId)
            }
        }

        // GATT client events.
        gattClient.listener = object : BLEGattClient.Listener {
            override fun onConnected(deviceId: String, mtuValue: Int) {
                updatePeerState(deviceId, ConnectionState.CONNECTED, mtuValue, ConnectionRole.CLIENT)
                listener?.onConnectionStateChange(ConnectionState.CONNECTED, deviceId, mtuValue)
            }

            override fun onDisconnected(deviceId: String, reason: String) {
                removePeerState(deviceId)
                syncLegacyState()
                listener?.onConnectionStateChange(ConnectionState.IDLE, deviceId, null)
            }

            override fun onDataReceived(deviceId: String, data: ByteArray) {
                // Data received from remote device (this phone is client role).
                // Use the deviceId provided by the per-peer callback.
                listener?.onDataReceived(data, deviceId)
            }

            override fun onError(deviceId: String?, code: String, message: String) {
                // Remove failed peer from peerStates if applicable
                if (deviceId != null) {
                    removePeerState(deviceId)
                }
                syncLegacyState()
                listener?.onConnectionError(code, message)
            }
        }
    }

    // ── Per-peer state management ────────────────────────────────────

    /**
     * Create or update the per-peer connection state for a given device.
     *
     * This is the single point of truth for connection state changes.
     * It updates [peerStates] and synchronizes the legacy properties.
     */
    private fun updatePeerState(
        deviceId: String,
        state: ConnectionState,
        mtuValue: Int,
        role: ConnectionRole
    ) {
        val existing = peerStates[deviceId]
        if (existing != null) {
            existing.state = state
            existing.mtu = mtuValue
        } else {
            peerStates[deviceId] = PeerConnectionState(
                deviceId = deviceId,
                state = state,
                mtu = mtuValue,
                role = role
            )
        }
        // Synchronize legacy properties
        syncLegacyState()
    }

    /**
     * Remove a peer from [peerStates] (on disconnect).
     *
     * Only removes the specific peer — other peers are unaffected.
     */
    private fun removePeerState(deviceId: String) {
        peerStates.remove(deviceId)
    }

    /**
     * Synchronize legacy single-peer properties from [peerStates].
     *
     * Finds the first CONNECTED peer and reflects its state in the legacy
     * properties. If no peers are connected, legacy state is set to IDLE.
     *
     * This ensures backward compatibility while [peerStates] remains
     * the source of truth.
     */
    private fun syncLegacyState() {
        val connected = peerStates.values.find { it.state == ConnectionState.CONNECTED }
        if (connected != null) {
            connectedDeviceId = connected.deviceId
            connectionState = connected.state
            mtu = connected.mtu
        } else {
            // No connected peers — check for connecting/disconnecting
            val active = peerStates.values.find {
                it.state == ConnectionState.CONNECTING || it.state == ConnectionState.DISCONNECTING
            }
            if (active != null) {
                connectedDeviceId = active.deviceId
                connectionState = active.state
            } else {
                connectedDeviceId = null
                connectionState = ConnectionState.IDLE
            }
        }
    }

    /**
     * Cancel a GATT server connection.
     */
    fun cancelConnection(device: BluetoothDevice) {
        gattServer.cancelConnection(device)
    }

    // ── Public API ────────────────────────────────────────────────────

    /** Start advertising and scanning for discovery. */
    fun startDiscovery() {
        val deviceId = BLEConstants.getOrCreateDeviceId(context)
        advertiser.startAdvertising(deviceId)
        scanner.startScanning()
        connectionState = ConnectionState.SCANNING
    }

    /** Stop scanning (advertising continues). */
    fun stopDiscovery() {
        scanner.stopScanning()
        if (connectionState == ConnectionState.SCANNING) {
            connectionState = ConnectionState.IDLE
        }
    }

    /**
     * Connect to a discovered device by its iTantra device ID.
     *
     * The BluetoothDevice must have been obtained from a scan result and registered
     * via registerDevice() before calling this.
     *
     * Multiple simultaneous connections are supported. Connecting to a new peer
     * does not block because another peer is already connected.
     */
    @SuppressLint("MissingPermission")
    fun connect(deviceId: String) {
        // Check if this deviceId is already connected/connecting
        val existingState = peerStates[deviceId]
        if (existingState != null && (
                existingState.state == ConnectionState.CONNECTED ||
                existingState.state == ConnectionState.CONNECTING
            )) {
            Log.w(TAG, "Already connected or connecting to $deviceId, ignoring")
            return
        }

        val btDevice = deviceMap[deviceId]
        if (btDevice == null) {
            listener?.onConnectionError("UNKNOWN_DEVICE", "No BluetoothDevice for $deviceId")
            return
        }

        // Create per-peer state in CONNECTING state
        updatePeerState(deviceId, ConnectionState.CONNECTING, 23, ConnectionRole.CLIENT)
        listener?.onConnectionStateChange(ConnectionState.CONNECTING, deviceId, null)

        gattClient.connect(btDevice, deviceId)
    }

    /**
     * Disconnect the active GATT client connection (legacy single-peer API).
     */
    fun disconnect() {
        // Capture CLIENT-role peer IDs before clearing: gattClient.disconnect()
        // removes their GATT entries synchronously, which suppresses the later
        // Android callbacks, so their disconnect events are emitted below.
        val clientIds = peerStates.values
            .filter { it.role == ConnectionRole.CLIENT }
            .map { it.deviceId }
        gattClient.disconnect()
        peerStates.clear()
        syncLegacyState()
        // Emit one disconnect event per affected CLIENT-role peer.
        clientIds.forEach { deviceId ->
            listener?.onConnectionStateChange(ConnectionState.IDLE, deviceId, null)
        }
    }

    /**
     * Send data to the connected peer (legacy single-peer API).
     */
    fun send(data: ByteArray): String? {
        // Use legacy connectedDeviceId to find the target peer
        val targetId = connectedDeviceId ?: return "NOT_CONNECTED"
        return send(data, targetId)
    }

    /** Stop everything. */
    fun stop() {
        disconnectAll()
        scanner.stopScanning()
        advertiser.stopAdvertising()
        gattServer.stop()
        peerStates.clear()
        syncLegacyState()
    }

    /**
     * Register a BluetoothDevice discovered during scanning so it can be used for connection.
     * Called internally when the scanner discovers a device and we extract the BluetoothDevice.
     */
    fun registerDevice(deviceId: String, device: BluetoothDevice) {
        deviceMap[deviceId] = device
    }

    /**
     * Start the GATT server so this device can accept incoming connections.
     */
    fun startGattServer() {
        gattServer.start()
    }

    /**
     * Stop the GATT server.
     */
    fun stopGattServer() {
        gattServer.stop()
    }

    // ── Internal helpers ──────────────────────────────────────────────

    private fun findDeviceIdByAddress(address: String): String? {
        return deviceMap.entries.find { it.value.address == address }?.key
    }
}
