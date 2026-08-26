package com.itantra.ble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.ParcelUuid
import android.util.Log

/**
 * BLE scanner that discovers nearby iTantra devices.
 *
 * Filters on the canonical SERVICE_UUID and deduplicates by MAC address,
 * updating RSSI for already-seen devices.
 */
class BLEScanner(private val context: Context) {

    companion object {
        private const val TAG = "BLEScanner"
    }

    /** Callback interface for delivering scan events to the module. */
    interface ScanListener {
        fun onDeviceFound(deviceId: String, name: String?, rssi: Int)
        fun onDeviceDiscovered(deviceId: String, device: android.bluetooth.BluetoothDevice)
        fun onScanError(code: String, message: String)
    }

    private val bluetoothManager: BluetoothManager? =
        context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager

    private val bluetoothAdapter: BluetoothAdapter? = bluetoothManager?.adapter

    private var scanner: BluetoothLeScanner? = null
    private var scanCallback: ScanCallback? = null
    var listener: ScanListener? = null

    /** True while a scan is in progress. */
    @Volatile
    var isScanning: Boolean = false
        private set

    /**
     * Start scanning for iTantra BLE services.
     *
     * @return null on success, or an error message string on failure.
     */
    @SuppressLint("MissingPermission")
    fun startScanning(): String? {
        if (isScanning) return null // idempotent

        val adapter = bluetoothAdapter
        if (adapter == null || !adapter.isEnabled) {
            return "BLUETOOTH_DISABLED"
        }

        scanner = adapter.bluetoothLeScanner
        if (scanner == null) {
            return "SCANNER_UNAVAILABLE"
        }

        // Filter: only accept advertisements that include the iTantra service UUID.
        val filter = ScanFilter.Builder()
            .setServiceUuid(ParcelUuid(BLEConstants.SERVICE_UUID))
            .build()

        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .setReportDelay(0) // deliver results immediately
            .build()

        scanCallback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val device = result.device
                val rssi = result.rssi

                // Extract device ID from manufacturer-specific data if present.
                val deviceId = extractDeviceId(result)
                    ?: device.address // fallback to MAC; real devices will have the ID

                val name = device.name // may be null

                listener?.onDeviceFound(deviceId, name, rssi)
                listener?.onDeviceDiscovered(deviceId, device)
            }

            override fun onBatchScanResults(results: MutableList<ScanResult>?) {
                results?.forEach { onScanResult(ScanSettings.CALLBACK_TYPE_ALL_MATCHES, it) }
            }

            override fun onScanFailed(errorCode: Int) {
                isScanning = false
                val reason = when (errorCode) {
                    SCAN_FAILED_ALREADY_STARTED -> "ALREADY_STARTED"
                    SCAN_FAILED_APPLICATION_REGISTRATION_FAILED -> "APP_REGISTRATION_FAILED"
                    SCAN_FAILED_INTERNAL_ERROR -> "INTERNAL_ERROR"
                    SCAN_FAILED_FEATURE_UNSUPPORTED -> "FEATURE_UNSUPPORTED"
                    SCAN_FAILED_OUT_OF_HARDWARE_RESOURCES -> "OUT_OF_HARDWARE_RESOURCES"
                    else -> "UNKNOWN($errorCode)"
                }
                Log.e(TAG, "Scan failed: $reason")
                listener?.onScanError(reason, "BLE scan failed: $reason")
            }
        }

        try {
            scanner?.startScan(listOf(filter), settings, scanCallback)
            isScanning = true
        } catch (e: SecurityException) {
            return "BLUETOOTH_PERMISSION_DENIED"
        } catch (e: Exception) {
            return "SCAN_ERROR: ${e.message}"
        }

        return null
    }

    /**
     * Stop BLE scanning.
     *
     * @return null on success, or an error message string on failure.
     */
    @SuppressLint("MissingPermission")
    fun stopScanning(): String? {
        if (!isScanning) return null // idempotent

        try {
            scanCallback?.let { scanner?.stopScan(it) }
        } catch (e: SecurityException) {
            return "BLUETOOTH_PERMISSION_DENIED"
        } catch (e: Exception) {
            return "STOP_SCAN_ERROR: ${e.message}"
        } finally {
            scanCallback = null
            isScanning = false
        }
        return null
    }

    /**
     * Try to extract the iTantra device ID from manufacturer-specific data.
     * Returns null if the data is missing or malformed.
     */
    private fun extractDeviceId(result: ScanResult): String? {
        val record = result.scanRecord ?: return null
        val bytes = record.getManufacturerSpecificData(BLEConstants.MANUFACTURER_ID) ?: return null
        return try {
            String(bytes, Charsets.UTF_8).trim().ifEmpty { null }
        } catch (e: Exception) {
            null
        }
    }
}
