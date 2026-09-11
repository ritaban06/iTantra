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
import java.util.concurrent.ConcurrentHashMap

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
        fun onClientConnected(device: BluetoothDevice, generation: Long)
        fun onClientDisconnected(device: BluetoothDevice, generation: Long)
        fun onDataReceived(data: ByteArray, device: BluetoothDevice)
    }

    private val bluetoothManager: BluetoothManager? =
        context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager

    private var gattServer: BluetoothGattServer? = null
    private val connectedClients = mutableSetOf<BluetoothDevice>()
    private val connectionGuard = ServerConnectionGuard()
    private val notificationSubscriptions = ServerNotificationSubscriptionGuard()
    /** Current in-flight notification correlation, keyed by remote BLE address. */
    private val notificationDiagnosticIds = ConcurrentHashMap<String, String>()
    private var serverGeneration = 0L

    /** Snapshot of the precise server-side state that determines notify eligibility. */
    data class NotificationDiagnostics(
        val connectedClientPresent: Boolean,
        val cccdEnabled: Boolean,
        val characteristicPresent: Boolean,
        val connectedClientCount: Int,
        val serverGeneration: Long,
        val connectionGeneration: Long?,
        val characteristicUuid: UUID?,
        val characteristicProperties: Int?,
        val running: Boolean,
    )

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
        serverGeneration += 1
        Log.d(
            "ITANTRA_MVP",
            "SERVER_SCHEMA service=${BLEConstants.SERVICE_UUID} rx=${BLEConstants.RX_CHAR_UUID} " +
                "cccd=${BLEConstants.CCCD_UUID} rxProperties=${rxChar.properties}"
        )
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
            connectionGuard.clear()
            notificationSubscriptions.clear()
            notificationDiagnosticIds.clear()
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
    fun sendNotification(data: ByteArray, device: BluetoothDevice, diagnosticId: String? = null): String? {
        val traceId = diagnosticId ?: "control"
        val diagnostics = getNotificationDiagnostics(device)
        val server = gattServer
        val rxChar = server?.getService(BLEConstants.SERVICE_UUID)
            ?.getCharacteristic(BLEConstants.RX_CHAR_UUID)
        Log.d(
            "ITANTRA_MVP",
            "msgId=$traceId STEP=SERVER_SEND_START blePeerId=${device.address} " +
                "connectedClientPresent=${diagnostics.connectedClientPresent} " +
                "cccdEnabled=${diagnostics.cccdEnabled} " +
                "characteristicPresent=${diagnostics.characteristicPresent} " +
                "connectedClientCount=${diagnostics.connectedClientCount} " +
                "serverGeneration=${diagnostics.serverGeneration} " +
                "connectionGeneration=${diagnostics.connectionGeneration ?: "NONE"} " +
                "serviceUuid=${BLEConstants.SERVICE_UUID} " +
                "characteristicUuid=${diagnostics.characteristicUuid ?: "NONE"} " +
                "cccdUuid=${BLEConstants.CCCD_UUID} " +
                "propertyFlags=${diagnostics.characteristicProperties ?: -1} running=${diagnostics.running}"
        )
        if (!diagnostics.connectedClientPresent) {
            Log.w(TAG, "sendNotification rejected: ${device.address} is not a current server client")
            return "NOT_CONNECTED"
        }
        if (!diagnostics.cccdEnabled) return "NOTIFICATION_NOT_READY"
        if (server == null) return "SERVER_NOT_RUNNING"
        if (rxChar == null) return "RX_CHARACTERISTIC_NOT_FOUND"

        // Serialize notifications per remote device — a new notify must not be
        // issued until the previous onNotificationSent completed. Completion
        // settles the synchronous String? contract via a latch.
        val completion = GattOperationCompletion()
        GattWriteQueue.enqueue(device.address, write = {
            // This closure runs only when this exact queue entry becomes the
            // in-flight platform operation, so the callback ID cannot belong
            // to a later buffered packet.
            notificationDiagnosticIds[device.address] = traceId
            rxChar.value = data
            val accepted = server.notifyCharacteristicChanged(device, rxChar, false)
            Log.d(
                "ITANTRA_MVP",
                "msgId=$traceId STEP=SERVER_NOTIFY_CALL blePeerId=${device.address} " +
                    "bytes=${data.size} booleanReturn=$accepted"
            )
            accepted
        }) { success ->
            Log.d(
                "ITANTRA_MVP",
                "msgId=$traceId STEP=SERVER_QUEUE_COMPLETE blePeerId=${device.address} success=$success"
            )
            notificationDiagnosticIds.remove(device.address, traceId)
            completion.complete(success, "NOTIFY_FAILED")
        }
        return completion.await(10, "NOTIFY_TIMEOUT")
    }

    /** Native snapshot used by BLEConnectionManager's exact-send diagnostics. */
    fun getNotificationDiagnostics(device: BluetoothDevice?): NotificationDiagnostics {
        val server = gattServer
        val rxChar = server?.getService(BLEConstants.SERVICE_UUID)
            ?.getCharacteristic(BLEConstants.RX_CHAR_UUID)
        val address = device?.address
        return NotificationDiagnostics(
            connectedClientPresent = address != null && getConnectedDevices().any {
                addressesEqual(it.address, address)
            },
            cccdEnabled = address != null && notificationSubscriptions.isEnabled(address),
            characteristicPresent = rxChar != null,
            connectedClientCount = getConnectedDevices().size,
            serverGeneration = serverGeneration,
            connectionGeneration = address?.let { connectionGuard.currentGeneration(it) },
            characteristicUuid = rxChar?.uuid,
            characteristicProperties = rxChar?.properties,
            running = isRunning,
        )
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
                    val generation = connectionGuard.markConnected(device.address, device)
                    synchronized(connectedClients) { connectedClients.add(device) }
                    notificationSubscriptions.markConnected(device.address)
                    Log.d(
                        "ITANTRA_MVP",
                        "STEP=SERVER_CONNECTED blePeerId=${device.address} generation=$generation " +
                            "serverGeneration=$serverGeneration notificationReady=false"
                    )
                }
                BluetoothProfile.STATE_DISCONNECTED -> {
                    val generation = connectionGuard.processDisconnect(device.address, device)
                    if (generation == null) {
                        Log.w(
                            TAG,
                            "Ignoring stale/duplicate disconnect for ${device.address}"
                        )
                        return
                    }
                    synchronized(connectedClients) { connectedClients.remove(device) }
                    notificationSubscriptions.remove(device.address)
                    notificationDiagnosticIds.remove(device.address)
                    // Settle queued notifications so no send promise hangs.
                    GattWriteQueue.clear(device.address)
                    Log.d(TAG, "Client disconnected: ${device.address} [gen=$generation]")
                    listener?.onClientDisconnected(device, generation)
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
            // CCCD is the server-side proof that this client can receive RX
            // notifications. Do not announce the peer to the application
            // connection map until this exact write has enabled notifications.
            if (descriptor.uuid == BLEConstants.CCCD_UUID) {
                val enablesRxNotifications =
                    descriptor.characteristic?.uuid == BLEConstants.RX_CHAR_UUID &&
                        value?.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) == true
                val currentGeneration = connectionGuard.currentGeneration(device.address)
                val becameReady = currentGeneration != null &&
                    notificationSubscriptions.setEnabled(device.address, enablesRxNotifications)
                Log.d(
                    "ITANTRA_MVP",
                    "STEP=CCCD_WRITE blePeerId=${device.address} serviceUuid=${BLEConstants.SERVICE_UUID} " +
                        "characteristicUuid=${descriptor.characteristic?.uuid ?: "NONE"} " +
                        "cccdUuid=${descriptor.uuid} rxEnabled=$enablesRxNotifications " +
                        "generation=${currentGeneration ?: "STALE"} becameReady=$becameReady"
                )
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
                if (becameReady) {
                    listener?.onClientConnected(device, currentGeneration!!)
                }
            } else {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, 0, null)
            }
        }

        override fun onNotificationSent(device: BluetoothDevice, status: Int) {
            // Capture before notifying the queue: queue completion may submit
            // the next buffered notification and replace this per-peer ID.
            val traceId = notificationDiagnosticIds[device.address] ?: "control"
            // Drive the per-peer notification queue: the next notify (if any)
            // is only submitted after this completion.
            GattWriteQueue.notifyCompleted(device.address, status == BluetoothGatt.GATT_SUCCESS)
            Log.d(
                "ITANTRA_MVP",
                "msgId=$traceId STEP=SERVER_NOTIFY_CALLBACK blePeerId=${device.address} status=$status"
            )
            if (status != BluetoothGatt.GATT_SUCCESS) {
                Log.w(TAG, "Notification failed to ${device.address}: $status")
            }
        }

        override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
            Log.d(TAG, "MTU changed for ${device.address}: $mtu")
        }
    }

    private fun addressesEqual(first: String?, second: String?): Boolean =
        first?.trim()?.equals(second?.trim(), ignoreCase = true) == true
}
