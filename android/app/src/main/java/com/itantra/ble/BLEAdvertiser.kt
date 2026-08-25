package com.itantra.ble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.content.Context
import android.os.ParcelUuid
import android.util.Log

/**
 * Handles BLE advertising for iTantra device discovery.
 *
 * Advertises the canonical SERVICE_UUID so nearby iTantra scanners can find this device.
 * The local device ID is included in manufacturer-specific data for identification.
 */
class BLEAdvertiser(private val context: Context) {

    companion object {
        private const val TAG = "BLEAdvertiser"
    }

    private val bluetoothManager: BluetoothManager? =
        context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager

    private val bluetoothAdapter: BluetoothAdapter? = bluetoothManager?.adapter

    private var advertiser: BluetoothLeAdvertiser? = null
    private var advertiseCallback: AdvertiseCallback? = null

    /** True while advertising is active. */
    @Volatile
    var isAdvertising: Boolean = false
        private set

    /**
     * Start BLE advertising.
     *
     * @param deviceId The local iTantra device ID to embed in advertisement data.
     * @return null on success, or an error message string on failure.
     */
    @SuppressLint("MissingPermission")
    fun startAdvertising(deviceId: String): String? {
        if (isAdvertising) return null // idempotent

        val adapter = bluetoothAdapter
        if (adapter == null || !adapter.isEnabled) {
            return "BLUETOOTH_DISABLED"
        }

        advertiser = adapter.bluetoothLeAdvertiser
        if (advertiser == null) {
            return "ADVERTISER_UNAVAILABLE"
        }

        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setConnectable(true)  // allow GATT connections from scanning devices
            .setTimeout(0)         // advertise indefinitely until stopped
            .build()

        // Encode the device ID as UTF-8 bytes for manufacturer data.
        val deviceIdBytes = deviceId.toByteArray(Charsets.UTF_8)

        val data = AdvertiseData.Builder()
            .addServiceUuid(ParcelUuid(BLEConstants.SERVICE_UUID))
            .addManufacturerData(BLEConstants.MANUFACTURER_ID, deviceIdBytes)
            .setIncludeDeviceName(false)
            .build()

        advertiseCallback = object : AdvertiseCallback() {
            override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
                isAdvertising = true
                Log.d(TAG, "Advertising started: $deviceId")
            }

            override fun onStartFailure(errorCode: Int) {
                isAdvertising = false
                val reason = when (errorCode) {
                    ADVERTISE_FAILED_DATA_TOO_LARGE -> "DATA_TOO_LARGE"
                    ADVERTISE_FAILED_TOO_MANY_ADVERTISERS -> "TOO_MANY_ADVERTISERS"
                    ADVERTISE_FAILED_ALREADY_STARTED -> "ALREADY_STARTED"
                    ADVERTISE_FAILED_INTERNAL_ERROR -> "INTERNAL_ERROR"
                    ADVERTISE_FAILED_FEATURE_UNSUPPORTED -> "FEATURE_UNSUPPORTED"
                    else -> "UNKNOWN($errorCode)"
                }
                Log.e(TAG, "Advertising failed: $reason")
            }
        }

        try {
            advertiser?.startAdvertising(settings, data, advertiseCallback)
        } catch (e: SecurityException) {
            return "BLUETOOTH_PERMISSION_DENIED"
        } catch (e: Exception) {
            return "ADVERTISING_ERROR: ${e.message}"
        }

        return null
    }

    /**
     * Stop BLE advertising.
     *
     * @return null on success, or an error message string on failure.
     */
    @SuppressLint("MissingPermission")
    fun stopAdvertising(): String? {
        if (!isAdvertising) return null // idempotent

        try {
            advertiseCallback?.let { advertiser?.stopAdvertising(it) }
        } catch (e: SecurityException) {
            return "BLUETOOTH_PERMISSION_DENIED"
        } catch (e: Exception) {
            return "STOP_ADVERTISING_ERROR: ${e.message}"
        } finally {
            advertiseCallback = null
            isAdvertising = false
        }
        return null
    }
}
