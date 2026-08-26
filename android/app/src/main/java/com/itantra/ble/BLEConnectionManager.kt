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
 */
class BLEConnectionManager(private val context: Context) {

    companion object {
        private const val TAG = "BLEConnManager"
    }

    enum class ConnectionState {
        IDLE, SCANNING, CONNECTING, CONNECTED, DISCONNECTING
    }

    interface Listener {
        fun onConnectionStateChange(state: ConnectionState, deviceId: String?, mtu: Int?)
        fun onDataReceived(data: ByteArray, fromDevice: String)
        fun onDeviceFound(deviceId: String, name: String?, rssi: Int)
        fun onScanError(code: String, message: String)
        fun onConnectionError(code: String, message: String)
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
                connectedDeviceId = fromDeviceId
                connectionState = ConnectionState.CONNECTED
                listener?.onConnectionStateChange(ConnectionState.CONNECTED, fromDeviceId, mtu)
            }

            override fun onClientDisconnected(device: BluetoothDevice) {
                Log.d(TAG, "GATT server: client disconnected ${device.address}")
                connectedDeviceId = null
                connectionState = ConnectionState.IDLE
                listener?.onConnectionStateChange(ConnectionState.IDLE, null, mtu)
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
                mtu = mtuValue
                connectedDeviceId = deviceId
                connectionState = ConnectionState.CONNECTED
                listener?.onConnectionStateChange(ConnectionState.CONNECTED, deviceId, mtuValue)
            }

            override fun onDisconnected(deviceId: String, reason: String) {
                connectionState = ConnectionState.IDLE
                connectedDeviceId = null
                listener?.onConnectionStateChange(ConnectionState.IDLE, deviceId, null)
            }

            override fun onDataReceived(data: ByteArray) {
                // Data received from remote device (this phone is client role).
                val fromDeviceId = connectedDeviceId ?: "unknown"
                listener?.onDataReceived(data, fromDeviceId)
            }

            override fun onError(code: String, message: String) {
                connectionState = ConnectionState.IDLE
                connectedDeviceId = null
                listener?.onConnectionError(code, message)
            }
        }
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
     */
    @SuppressLint("MissingPermission")
    fun connect(deviceId: String) {
        val btDevice = deviceMap[deviceId]
        if (btDevice == null) {
            listener?.onConnectionError("UNKNOWN_DEVICE", "No BluetoothDevice for $deviceId")
            return
        }

        connectionState = ConnectionState.CONNECTING
        listener?.onConnectionStateChange(ConnectionState.CONNECTING, deviceId, null)

        gattClient.connect(btDevice, deviceId)
    }

    /** Disconnect the active GATT client connection. */
    fun disconnect() {
        connectionState = ConnectionState.DISCONNECTING
        gattClient.disconnect()
        connectionState = ConnectionState.IDLE
        connectedDeviceId = null
    }

    /** Send data to the connected peer. */
    fun send(data: ByteArray): String? {
        if (gattClient.isConnected) {
            return gattClient.send(data)
        }
        
        // If not connected as client, try as server.
        val deviceAddress = connectedDeviceId?.let { deviceMap[it]?.address }
        if (deviceAddress != null) {
            val device = bluetoothManager?.adapter?.getRemoteDevice(deviceAddress)
            if (device != null && gattServer.isRunning) {
                return gattServer.sendNotification(data, device)
            }
        }
        return "NOT_CONNECTED"
    }

    /** Stop everything. */
    fun stop() {
        disconnect()
        scanner.stopScanning()
        advertiser.stopAdvertising()
        gattServer.stop()
        connectionState = ConnectionState.IDLE
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
