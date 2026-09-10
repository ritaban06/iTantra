package com.itantra.ble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.util.Log
import java.util.UUID

/**
 * GATT server that hosts the iTantra BLE service.
 *
 * Characteristics:
 * - TX_CHAR: remote clients write data to this characteristic.
 * - RX_CHAR: server sends notifications to connected clients through this.
 */
class BLEGattServer(private val context: Context) {

    companion object {
        private const val TAG = "BLEGattServer"
    }

    interface Listener {
        fun onClientConnected(device: BluetoothDevice)
        fun onClientDisconnected(device: BluetoothDevice)
        fun onDataReceived(data: ByteArray, device: BluetoothDevice)
    }

    private val bluetoothManager: BluetoothManager? =
        context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager

    private var gattServer: BluetoothGattServer? = null
    private val connectedClients = mutableSetOf<BluetoothDevice>()

    var listener: Listener? = null

    @Volatile
    var isRunning: Boolean = false
        private set

    /**
     * Start the GATT server with the iTantra service.
     *
     * @return null on success, or an error string on failure.
     */
    @SuppressLint("MissingPermission")
    fun start(): String? {
        if (isRunning) return null

        val server = bluetoothManager?.openGattServer(context, gattServerCallback)
        if (server == null) return "GATT_SERVER_OPEN_FAILED"

        // Build the iTantra service with TX and RX characteristics.
        val service = BluetoothGattService(BLEConstants.SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)

        // TX: client writes data here.
        val txChar = BluetoothGattCharacteristic(
            BLEConstants.TX_CHAR_UUID,
            BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
            BluetoothGattCharacteristic.PERMISSION_WRITE
        )
        service.addCharacteristic(txChar)

        // RX: server notifies client through this.
        val rxChar = BluetoothGattCharacteristic(
            BLEConstants.RX_CHAR_UUID,
            BluetoothGattCharacteristic.PROPERTY_NOTIFY,
            0 // no permission needed for read/notify
        )
        // Add the CCCD descriptor so clients can enable notifications.
        val cccd = android.bluetooth.BluetoothGattDescriptor(
            BLEConstants.CCCD_UUID,
            android.bluetooth.BluetoothGattDescriptor.PERMISSION_READ or android.bluetooth.BluetoothGattDescriptor.PERMISSION_WRITE
        )
        rxChar.addDescriptor(cccd)
        service.addCharacteristic(rxChar)

        val added = server.addService(service)
        if (!added) {
            server.close()
            return "SERVICE_ADD_FAILED"
        }

        gattServer = server
        isRunning = true
        Log.d(TAG, "GATT server started")
        return null
    }

    /**
     * Stop the GATT server and disconnect all clients.
     *
     * @return null on success, or an error string on failure.
     */
    @SuppressLint("MissingPermission")
    fun stop(): String? {
        if (!isRunning) return null

        try {
            connectedClients.forEach { device ->
                try {
                    gattServer?.cancelConnection(device)
                } catch (_: Exception) {}
            }
            connectedClients.clear()
            gattServer?.close()
        } catch (e: Exception) {
            return "STOP_SERVER_ERROR: ${e.message}"
        } finally {
            gattServer = null
            isRunning = false
            // Fail any queued notifications — nothing can complete after stop().
            GattWriteQueue.clearAll()
        }
        Log.d(TAG, "GATT server stopped")
        return null
    }

    /**
     * Disconnect a specific remote client from the GATT server.
     *
     * Other connected clients are not affected.
     *
     * @param device The remote device to disconnect.
     */
    @SuppressLint("MissingPermission")
    fun cancelConnection(device: BluetoothDevice) {
        try {
            gattServer?.cancelConnection(device)
        } catch (e: Exception) {
            Log.e(TAG, "Error cancelling connection to ${device.address}: ${e.message}")
        }
    }

    /**
     * Send a notification to a connected client.
     *
     * @return null on success, or an error string on failure.
     */
    @SuppressLint("MissingPermission")
    fun sendNotification(data: ByteArray, device: BluetoothDevice): String? {
        val server = gattServer ?: return "SERVER_NOT_RUNNING"

        val service = server.getService(BLEConstants.SERVICE_UUID)
            ?: return "SERVICE_NOT_FOUND"

        val rxChar = service.getCharacteristic(BLEConstants.RX_CHAR_UUID)
            ?: return "RX_CHARACTERISTIC_NOT_FOUND"

        // Serialize notifications per remote device — a new notify must not be
        // issued until the previous onNotificationSent completed. Completion
        // settles the synchronous String? contract via a latch.
        var result: String? = null
        val latch = java.util.concurrent.CountDownLatch(1)
        GattWriteQueue.enqueue(device.address, write = {
            rxChar.value = data
            server.notifyCharacteristicChanged(device, rxChar, false)
        }) { success ->
            result = if (success) null else "NOTIFY_FAILED"
            latch.countDown()
        }
        return try {
            latch.await(10, java.util.concurrent.TimeUnit.SECONDS)
            result ?: "NOTIFY_TIMEOUT"
        } catch (_: InterruptedException) {
            "NOTIFY_TIMEOUT"
        }
    }

    /** Get all currently connected client devices. */
    fun getConnectedDevices(): Set<BluetoothDevice> = synchronized(connectedClients) {
        connectedClients.toSet()
    }

    // ── GATT Server Callback ──────────────────────────────────────────

    private val gattServerCallback = object : BluetoothGattServerCallback() {

        @SuppressLint("MissingPermission")
        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> {
                    synchronized(connectedClients) { connectedClients.add(device) }
                    Log.d(TAG, "Client connected: ${device.address}")
                    listener?.onClientConnected(device)
                }
                BluetoothProfile.STATE_DISCONNECTED -> {
                    synchronized(connectedClients) { connectedClients.remove(device) }
                    // Settle queued notifications so no send promise hangs.
                    GattWriteQueue.clear(device.address)
                    Log.d(TAG, "Client disconnected: ${device.address}")
                    listener?.onClientDisconnected(device)
                }
            }
        }

        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            characteristic: android.bluetooth.BluetoothGattCharacteristic,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray?
        ) {
            if (characteristic.uuid == BLEConstants.TX_CHAR_UUID && value != null) {
                listener?.onDataReceived(value, device)
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
            } else {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, 0, null)
            }
        }

        override fun onDescriptorWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            descriptor: android.bluetooth.BluetoothGattDescriptor,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray?
        ) {
            // Allow CCCD writes (notification enable/disable).
            if (descriptor.uuid == BLEConstants.CCCD_UUID) {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
            } else {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, 0, null)
            }
        }

        override fun onNotificationSent(device: BluetoothDevice, status: Int) {
            // Drive the per-peer notification queue: the next notify (if any)
            // is only submitted after this completion.
            GattWriteQueue.notifyCompleted(device.address, status == BluetoothGatt.GATT_SUCCESS)
            if (status != BluetoothGatt.GATT_SUCCESS) {
                Log.w(TAG, "Notification failed to ${device.address}: $status")
            }
        }

        override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
            Log.d(TAG, "MTU changed for ${device.address}: $mtu")
        }
    }
}
