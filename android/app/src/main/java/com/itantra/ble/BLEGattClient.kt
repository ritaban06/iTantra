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

/**
 * GATT client that connects to a remote iTantra device.
 *
 * After connection: discovers services, locates iTantra TX/RX characteristics,
 * enables notifications on RX, and provides send() for TX writes.
 */
class BLEGattClient(private val context: Context) {

    companion object {
        private const val TAG = "BLEGattClient"
        private const val REQUEST_MTU = 512
    }

    interface Listener {
        fun onConnected(deviceId: String, mtu: Int)
        fun onDisconnected(deviceId: String, reason: String)
        fun onDataReceived(data: ByteArray)
        fun onError(code: String, message: String)
    }

    private val bluetoothManager: BluetoothManager? =
        context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager

    private var bluetoothGatt: BluetoothGatt? = null
    private var txCharacteristic: BluetoothGattCharacteristic? = null
    private var remoteDeviceId: String = ""

    var listener: Listener? = null

    /** Current connection state. */
    @Volatile
    var isConnected: Boolean = false
        private set

    /** Negotiated MTU (default 23 until negotiated). */
    @Volatile
    var mtu: Int = 23
        private set

    /**
     * Connect to a remote BluetoothDevice.
     *
     * @param device The Android BluetoothDevice to connect to.
     * @param deviceId The iTantra device ID (from scan results) for event reporting.
     */
    @SuppressLint("MissingPermission")
    fun connect(device: BluetoothDevice, deviceId: String) {
        if (isConnected || bluetoothGatt != null) {
            Log.w(TAG, "Already connected or connecting, ignoring connect to $deviceId")
            return
        }

        remoteDeviceId = deviceId
        Log.d(TAG, "Connecting to $deviceId (${device.address})")

        bluetoothGatt = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
        } else {
            @Suppress("DEPRECATION")
            device.connectGatt(context, false, gattCallback)
        }
    }

    /**
     * Disconnect and close the GATT connection.
     */
    @SuppressLint("MissingPermission")
    fun disconnect() {
        val gatt = bluetoothGatt ?: return
        try {
            if (isConnected) {
                gatt.disconnect()
            }
            gatt.close()
        } catch (e: Exception) {
            Log.e(TAG, "Error during disconnect: ${e.message}")
        } finally {
            bluetoothGatt = null
            txCharacteristic = null
            isConnected = false
        }
    }

    /**
     * Send data to the remote device via the TX characteristic.
     *
     * @return null on success, or an error string.
     */
    @SuppressLint("MissingPermission")
    fun send(data: ByteArray): String? {
        val gatt = bluetoothGatt ?: return "NOT_CONNECTED"
        if (!isConnected) return "NOT_CONNECTED"

        val char = txCharacteristic ?: return "TX_CHARACTERISTIC_NOT_FOUND"

        char.value = data
        val success = gatt.writeCharacteristic(char)
        return if (success) null else "WRITE_FAILED"
    }

    /**
     * Request a larger MTU.
     */
    @SuppressLint("MissingPermission")
    fun requestMtu(mtuSize: Int = REQUEST_MTU) {
        bluetoothGatt?.requestMtu(mtuSize)
    }

    // ── GATT Client Callback ──────────────────────────────────────────

    private val gattCallback = object : BluetoothGattCallback() {

        @SuppressLint("MissingPermission")
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> {
                    Log.d(TAG, "Connected to $remoteDeviceId, discovering services...")
                    // Request larger MTU before service discovery.
                    gatt.requestMtu(REQUEST_MTU)
                }
                BluetoothProfile.STATE_DISCONNECTED -> {
                    isConnected = false
                    val reason = if (status == BluetoothGatt.GATT_SUCCESS) "LOCAL" else "ERROR($status)"
                    Log.d(TAG, "Disconnected from $remoteDeviceId: $reason")
                    listener?.onDisconnected(remoteDeviceId, reason)
                    try { gatt.close() } catch (_: Exception) {}
                    bluetoothGatt = null
                    txCharacteristic = null
                }
            }
        }

        @SuppressLint("MissingPermission")
        override fun onMtuChanged(gatt: BluetoothGatt, mtuValue: Int, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                mtu = mtuValue
                Log.d(TAG, "MTU negotiated: $mtuValue")
            }
            // Proceed with service discovery regardless of MTU result.
            gatt.discoverServices()
        }

        @SuppressLint("MissingPermission")
        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                listener?.onError("SERVICE_DISCOVERY_FAILED", "Service discovery failed: $status")
                return
            }

            // Locate the iTantra service.
            val service = gatt.getService(BLEConstants.SERVICE_UUID)
            if (service == null) {
                listener?.onError("SERVICE_NOT_FOUND", "iTantra service not found on remote device")
                gatt.disconnect()
                return
            }

            // Locate TX characteristic (for sending data).
            txCharacteristic = service.getCharacteristic(BLEConstants.TX_CHAR_UUID)
            if (txCharacteristic == null) {
                listener?.onError("TX_NOT_FOUND", "TX characteristic not found")
                gatt.disconnect()
                return
            }

            // Locate RX characteristic and enable notifications.
            val rxChar = service.getCharacteristic(BLEConstants.RX_CHAR_UUID)
            if (rxChar == null) {
                listener?.onError("RX_NOT_FOUND", "RX characteristic not found")
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
                Log.w(TAG, "CCCD descriptor not found on RX characteristic")
                isConnected = true
                listener?.onConnected(remoteDeviceId, mtu)
            }
        }

        override fun onCharacteristicWrite(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int
        ) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                // Write succeeded — no event needed for now; send success is reported by BLEModule.
            } else {
                listener?.onError("WRITE_FAILED", "Characteristic write failed: $status")
            }
        }

        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic
        ) {
            if (characteristic.uuid == BLEConstants.RX_CHAR_UUID) {
                val data = characteristic.value
                if (data != null && data.isNotEmpty()) {
                    listener?.onDataReceived(data)
                }
            }
        }

        override fun onDescriptorWrite(
            gatt: BluetoothGatt,
            descriptor: BluetoothGattDescriptor,
            status: Int
        ) {
            if (descriptor.characteristic?.uuid == BLEConstants.RX_CHAR_UUID) {
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    // Notifications enabled — connection is fully established.
                    isConnected = true
                    Log.d(TAG, "Notifications enabled, connection ready to $remoteDeviceId")
                    listener?.onConnected(remoteDeviceId, mtu)
                } else {
                    listener?.onError("NOTIFICATION_ENABLE_FAILED", "Failed to enable notifications: $status")
                    gatt.disconnect()
                }
            }
        }
    }
}
