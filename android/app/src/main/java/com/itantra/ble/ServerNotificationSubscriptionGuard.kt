package com.itantra.ble

/**
 * Tracks RX-notification subscriptions for the current server-side clients.
 *
 * A GATT connection alone does not make server notifications deliverable: the
 * remote client must first write ENABLE_NOTIFICATION_VALUE to the RX CCCD.
 * Keys are normalized Bluetooth addresses because that is the identity used
 * by the platform GATT-server callback and notification queue.
 */
internal class ServerNotificationSubscriptionGuard {
    private val enabledAddresses = mutableSetOf<String>()

    /** A new physical connection must explicitly subscribe again. */
    @Synchronized
    fun markConnected(address: String) {
        enabledAddresses.remove(normalize(address))
    }

    /** Returns true only for the transition from disabled to enabled. */
    @Synchronized
    fun setEnabled(address: String, enabled: Boolean): Boolean {
        val normalized = normalize(address)
        return if (enabled) {
            enabledAddresses.add(normalized)
        } else {
            enabledAddresses.remove(normalized)
            false
        }
    }

    @Synchronized
    fun isEnabled(address: String): Boolean = enabledAddresses.contains(normalize(address))

    @Synchronized
    fun remove(address: String) {
        enabledAddresses.remove(normalize(address))
    }

    @Synchronized
    fun clear() {
        enabledAddresses.clear()
    }

    private fun normalize(address: String): String = address.trim().uppercase()
}
