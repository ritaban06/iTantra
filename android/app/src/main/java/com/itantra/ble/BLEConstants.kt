package com.itantra.ble

import android.content.Context
import android.content.SharedPreferences
import java.util.UUID

object BLEConstants {
    // ── Service & characteristic UUIDs ───────────────────────────────

    /** iTantra GATT service UUID. */
    val SERVICE_UUID: UUID = UUID.fromString("12345678-1234-1234-1234-123456789ABC")

    /** TX characteristic — remote client writes data to this. */
    val TX_CHAR_UUID: UUID = UUID.fromString("12345678-1234-1234-1234-123456789ABD")

    /** RX characteristic — server notifies client through this. */
    val RX_CHAR_UUID: UUID = UUID.fromString("12345678-1234-1234-1234-123456789ABE")

    /** Client Characteristic Configuration Descriptor (standard BLE). */
    val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

    // ── Manufacturer data ────────────────────────────────────────────

    /** Manufacturer ID for iTantra (non-reserved range, 0x0001–0xFFFF). */
    const val MANUFACTURER_ID: Int = 0x027A  // arbitrary, 634 decimal

    // ── Device ID persistence ────────────────────────────────────────

    private const val PREFS_NAME = "itantra_ble"
    private const val KEY_DEVICE_ID = "device_id"

    /** Generate a device ID in the format ITN-XXXX-XXXX (8 hex chars). */
    fun generateDeviceId(): String {
        val random = java.util.Random()
        val part1 = random.nextInt(0xFFFF).toString(16).uppercase().padStart(4, '0')
        val part2 = random.nextInt(0xFFFF).toString(16).uppercase().padStart(4, '0')
        return "ITN-$part1-$part2"
    }

    /**
     * Get or create the persisted local device ID.
     * Once created, this ID persists across app restarts.
     */
    fun getOrCreateDeviceId(context: Context): String {
        val prefs: SharedPreferences =
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val existing = prefs.getString(KEY_DEVICE_ID, null)
        if (existing != null) return existing

        val newId = generateDeviceId()
        prefs.edit().putString(KEY_DEVICE_ID, newId).apply()
        return newId
    }

    // ── Event names emitted from Kotlin → JS ──────────────────────────

    const val EVENT_DEVICE_FOUND         = "BLE_DEVICE_FOUND"
    const val EVENT_SCAN_ERROR           = "BLE_SCAN_ERROR"
    const val EVENT_ADVERTISING_STARTED  = "BLE_ADVERTISING_STARTED"
    const val EVENT_ADVERTISING_STOPPED  = "BLE_ADVERTISING_STOPPED"
    const val EVENT_ERROR                = "BLE_ERROR"
    const val EVENT_CONNECTING           = "BLE_CONNECTING"
    const val EVENT_CONNECTED            = "BLE_CONNECTED"
    const val EVENT_DISCONNECTED         = "BLE_DISCONNECTED"
    const val EVENT_DATA_RECEIVED        = "BLE_DATA_RECEIVED"
    const val EVENT_SEND_SUCCESS         = "BLE_SEND_SUCCESS"
    const val EVENT_SEND_FAILED          = "BLE_SEND_FAILED"
    const val EVENT_CONNECTION_ERROR     = "BLE_CONNECTION_ERROR"
}
