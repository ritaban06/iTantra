package com.itantra.ble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * React Native bridge for BLE discovery + GATT connection.
 *
 * V1: scanning, advertising, device discovery.
 * V2: GATT connect/disconnect, data send/receive, connection state.
 */
class BLEModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), BLEScanner.ScanListener {

    companion object {
        var instance: BLEModule? = null
    }

    private val connManager = BLEConnectionManager(reactApplicationContext)
    private val deviceId: String = BLEConstants.getOrCreateDeviceId(reactApplicationContext)

    init {
        instance = this
        connManager.scanner.listener = this

        // Forward connection manager events to React Native.
        connManager.listener = object : BLEConnectionManager.Listener {
            override fun onConnectionStateChange(
                state: BLEConnectionManager.ConnectionState,
                devId: String?,
                mtuVal: Int?
            ) {
                when (state) {
                    BLEConnectionManager.ConnectionState.CONNECTING -> {
                        val map = Arguments.createMap().apply {
                            putString("deviceId", devId ?: "")
                        }
                        emitEvent(BLEConstants.EVENT_CONNECTING, map)
                    }
                    BLEConnectionManager.ConnectionState.CONNECTED -> {
                        val map = Arguments.createMap().apply {
                            putString("deviceId", devId ?: "")
                            putInt("mtu", mtuVal ?: 23)
                        }
                        emitEvent(BLEConstants.EVENT_CONNECTED, map)
                    }
                    BLEConnectionManager.ConnectionState.IDLE,
                    BLEConnectionManager.ConnectionState.DISCONNECTING -> {
                        val map = Arguments.createMap().apply {
                            putString("deviceId", devId ?: "")
                            putString("reason", "LOCAL")
                        }
                        emitEvent(BLEConstants.EVENT_DISCONNECTED, map)
                    }
                    else -> {}
                }
            }

            override fun onDataReceived(data: ByteArray, fromDevice: String) {
                val map = Arguments.createMap().apply {
                    putString("data", Base64.encodeToString(data, Base64.NO_WRAP))
                    putString("fromDevice", fromDevice)
                }
                emitEvent(BLEConstants.EVENT_DATA_RECEIVED, map)
            }

            override fun onDeviceFound(foundDeviceId: String, name: String?, rssi: Int) {
                // Already handled by BLEModule.onDeviceFound (ScanListener).
            }

            override fun onScanError(code: String, message: String) {
                val map = Arguments.createMap().apply {
                    putString("code", code)
                    putString("message", message)
                }
                emitEvent(BLEConstants.EVENT_SCAN_ERROR, map)
            }

            override fun onConnectionError(code: String, message: String) {
                val map = Arguments.createMap().apply {
                    putString("code", code)
                    putString("message", message)
                }
                emitEvent(BLEConstants.EVENT_CONNECTION_ERROR, map)
            }
        }
    }

    override fun getName(): String = "NativeBLE"

    // ── Event emission helper ─────────────────────────────────────────

    private fun emitEvent(eventName: String, params: WritableMap?) {
        if (reactApplicationContext.hasActiveCatalystInstance()) {
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(eventName, params)
        }
    }

    // ── Permission helpers ────────────────────────────────────────────

    private fun missingBlePermissions(): List<String> {
        val ctx = reactApplicationContext
        val needed = mutableListOf<String>()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (ctx.checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) != PackageManager.PERMISSION_GRANTED) {
                needed.add(Manifest.permission.BLUETOOTH_SCAN)
            }
            if (ctx.checkSelfPermission(Manifest.permission.BLUETOOTH_ADVERTISE) != PackageManager.PERMISSION_GRANTED) {
                needed.add(Manifest.permission.BLUETOOTH_ADVERTISE)
            }
            if (ctx.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
                needed.add(Manifest.permission.BLUETOOTH_CONNECT)
            }
        } else {
            if (ctx.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                needed.add(Manifest.permission.ACCESS_FINE_LOCATION)
            }
        }

        return needed
    }

    // ── BLEScanner.ScanListener ───────────────────────────────────────

    override fun onDeviceFound(foundDeviceId: String, name: String?, rssi: Int) {
        val map = Arguments.createMap().apply {
            putString("deviceId", foundDeviceId)
            putString("name", name)
            putInt("rssi", rssi)
        }
        emitEvent(BLEConstants.EVENT_DEVICE_FOUND, map)
    }

    override fun onDeviceDiscovered(foundDeviceId: String, device: BluetoothDevice) {
        // Register the BluetoothDevice so we can connect later by device ID.
        connManager.registerDevice(foundDeviceId, device)
    }

    override fun onScanError(code: String, message: String) {
        val map = Arguments.createMap().apply {
            putString("code", code)
            putString("message", message)
        }
        emitEvent(BLEConstants.EVENT_SCAN_ERROR, map)
    }

    // ── V1 Discovery @ReactMethods ────────────────────────────────────

    @ReactMethod
    fun getDeviceId(promise: Promise) {
        promise.resolve(deviceId)
    }

    @ReactMethod
    fun isBluetoothEnabled(promise: Promise) {
        val adapter = (reactApplicationContext.getSystemService(
            android.content.Context.BLUETOOTH_SERVICE
        ) as? android.bluetooth.BluetoothManager)?.adapter
        promise.resolve(adapter?.isEnabled == true)
    }

    @ReactMethod
    fun getMissingPermissions(promise: Promise) {
        val missing = Arguments.createArray()
        missingBlePermissions().forEach { missing.pushString(it) }
        promise.resolve(missing)
    }

    @ReactMethod
    fun startAdvertising(promise: Promise) {
        val missing = missingBlePermissions()
        if (missing.isNotEmpty()) {
            promise.reject("BLE_PERMISSION_DENIED", "Missing permissions: ${missing.joinToString()}")
            return
        }

        // Start GATT server so the device can accept incoming connections.
        connManager.startGattServer()

        val error = connManager.advertiser.startAdvertising(deviceId)
        if (error != null) {
            promise.reject("BLE_ADVERTISING_FAILED", error)
            return
        }

        val map = Arguments.createMap().apply {
            putString("deviceId", deviceId)
        }
        emitEvent(BLEConstants.EVENT_ADVERTISING_STARTED, map)
        promise.resolve(true)
    }

    @ReactMethod
    fun stopAdvertising(promise: Promise) {
        val missing = missingBlePermissions()
        if (missing.isNotEmpty()) {
            promise.reject("BLE_PERMISSION_DENIED", "Missing permissions: ${missing.joinToString()}")
            return
        }

        val error = connManager.advertiser.stopAdvertising()
        if (error != null) {
            promise.reject("BLE_STOP_ADVERTISING_FAILED", error)
            return
        }

        connManager.stopGattServer()
        emitEvent(BLEConstants.EVENT_ADVERTISING_STOPPED, null)
        promise.resolve(true)
    }

    @ReactMethod
    fun isAdvertising(promise: Promise) {
        promise.resolve(connManager.advertiser.isAdvertising)
    }

    @ReactMethod
    fun startScanning(promise: Promise) {
        val missing = missingBlePermissions()
        if (missing.isNotEmpty()) {
            promise.reject("BLE_PERMISSION_DENIED", "Missing permissions: ${missing.joinToString()}")
            return
        }

        val error = connManager.scanner.startScanning()
        if (error != null) {
            promise.reject("BLE_SCAN_FAILED", error)
            return
        }

        promise.resolve(true)
    }

    @ReactMethod
    fun stopScanning(promise: Promise) {
        val missing = missingBlePermissions()
        if (missing.isNotEmpty()) {
            promise.reject("BLE_PERMISSION_DENIED", "Missing permissions: ${missing.joinToString()}")
            return
        }

        val error = connManager.scanner.stopScanning()
        if (error != null) {
            promise.reject("BLE_STOP_SCAN_FAILED", error)
            return
        }

        promise.resolve(true)
    }

    @ReactMethod
    fun isScanning(promise: Promise) {
        promise.resolve(connManager.scanner.isScanning)
    }

    // ── V2 GATT @ReactMethods ─────────────────────────────────────────

    @SuppressLint("MissingPermission")
    @ReactMethod
    fun connect(deviceId: String, options: ReadableMap?, promise: Promise) {
        val missing = missingBlePermissions()
        if (missing.isNotEmpty()) {
            promise.reject("BLE_PERMISSION_DENIED", "Missing permissions: ${missing.joinToString()}")
            return
        }

        // Multi-peer: only reject if THIS specific device is already connecting/connected.
        if (connManager.isConnectedTo(deviceId)) {
            promise.reject("ALREADY_CONNECTED", "Already connected to $deviceId")
            return
        }
        val existingState = connManager.peerStates[deviceId]
        if (existingState?.state == BLEConnectionManager.ConnectionState.CONNECTING) {
            promise.reject("ALREADY_CONNECTING", "Already connecting to $deviceId")
            return
        }

        connManager.connect(deviceId)
        promise.resolve(true)
    }

    @ReactMethod
    fun disconnect(options: ReadableMap?, promise: Promise) {
        val targetDeviceId = options?.getString("deviceId")
        if (targetDeviceId != null) {
            // Peer-targeted disconnect
            connManager.disconnect(targetDeviceId)
        } else {
            // Legacy disconnect-all behavior
            connManager.disconnect()
        }
        promise.resolve(true)
    }

    @ReactMethod
    fun send(base64Data: String, options: ReadableMap?, promise: Promise) {
        val targetDeviceId = options?.getString("deviceId")

        val data = try {
            Base64.decode(base64Data, Base64.NO_WRAP)
        } catch (e: Exception) {
            promise.reject("INVALID_DATA", "Invalid Base64 data: ${e.message}")
            return
        }

        if (targetDeviceId != null) {
            // Peer-targeted send: route to specific peer.
            // Do NOT fall back to another peer if this one is unavailable.
            val connected = connManager.isConnectedTo(targetDeviceId)
            val peerState = connManager.peerStates[targetDeviceId]
            Log.d(
                "ITANTRA_MVP",
                "NATIVE_SEND target=$targetDeviceId nativeState=${peerState?.state ?: "MISSING"} " +
                    "role=${peerState?.role ?: "UNKNOWN"}"
            )
            Log.d(
                "ITANTRA_SEND",
                "requestedDeviceId=$targetDeviceId isConnectedTo=$connected " +
                    "peerState=${peerState?.state ?: "MISSING"} role=${peerState?.role ?: "UNKNOWN"}"
            )
            if (!connected) {
                promise.reject("NOT_CONNECTED", "Peer $targetDeviceId is not connected")
                return
            }
            val error = connManager.send(data, targetDeviceId)
            Log.d(
                "ITANTRA_SEND",
                "requestedDeviceId=$targetDeviceId result=${error ?: "OK"}"
            )
            if (error != null) {
                val map = Arguments.createMap().apply {
                    putString("error", error)
                }
                emitEvent(BLEConstants.EVENT_SEND_FAILED, map)
                promise.reject("SEND_FAILED", error)
                return
            }
            val map = Arguments.createMap().apply {
                putInt("bytesWritten", data.size)
            }
            emitEvent(BLEConstants.EVENT_SEND_SUCCESS, map)
            promise.resolve(true)
        } else {
            // Legacy single-peer send: use legacy connectedDeviceId.
            if (connManager.connectionState != BLEConnectionManager.ConnectionState.CONNECTED) {
                promise.reject("NOT_CONNECTED", "Not connected to any device")
                return
            }
            val error = connManager.send(data)
            if (error != null) {
                val map = Arguments.createMap().apply {
                    putString("error", error)
                }
                emitEvent(BLEConstants.EVENT_SEND_FAILED, map)
                promise.reject("SEND_FAILED", error)
                return
            }
            val map = Arguments.createMap().apply {
                putInt("bytesWritten", data.size)
            }
            emitEvent(BLEConstants.EVENT_SEND_SUCCESS, map)
            promise.resolve(true)
        }
    }

    @ReactMethod
    fun getConnectionState(options: ReadableMap?, promise: Promise) {
        val targetDeviceId = options?.getString("deviceId")

        if (targetDeviceId != null) {
            // Per-peer state query
            val peerState = connManager.peerStates[targetDeviceId]
            Log.d(
                "ITANTRA_QUERY",
                "operation=getConnectionState requestedDeviceId=$targetDeviceId " +
                    "peerStateExists=${peerState != null} actualStoredDeviceId=${peerState?.deviceId ?: ""} " +
                    "actualState=${peerState?.state ?: "IDLE"} role=${peerState?.role ?: "UNKNOWN"} " +
                    "peerStatesKeys=${connManager.peerStates.keys}"
            )
            val map = Arguments.createMap().apply {
                if (peerState != null) {
                    putString("state", peerState.state.name)
                    putString("deviceId", peerState.deviceId)
                    putInt("mtu", peerState.mtu)
                    putString("role", peerState.role.name)
                } else {
                    putString("state", "IDLE")
                    putString("deviceId", targetDeviceId)
                    putInt("mtu", 23)
                    putString("role", "UNKNOWN")
                }
            }
            promise.resolve(map)
        } else {
            // Legacy single-peer state query
            val map = Arguments.createMap().apply {
                putString("state", connManager.connectionState.name)
                putString("deviceId", connManager.connectedDeviceId ?: "")
                putInt("mtu", connManager.mtu)
            }
            promise.resolve(map)
        }
    }

    /** Return the exact device IDs used by the native connection registry. */
    @ReactMethod
    fun getConnectedDeviceIds(promise: Promise) {
        val ids = Arguments.createArray()
        val connectedIds = connManager.getConnectedDeviceIds()
        Log.d("ITANTRA_QUERY", "operation=getConnectedDeviceIds result=$connectedIds")
        connectedIds.forEach { ids.pushString(it) }
        promise.resolve(ids)
    }

    // ── Required by RN event emitter ──────────────────────────────────

    @ReactMethod
    fun addListeners(count: Int?) {}

    @ReactMethod
    fun removeListeners(count: Int?) {}
}
