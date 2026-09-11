package com.itantra.ble

import java.util.IdentityHashMap

/**
 * Tracks the current server-side connection generation by Bluetooth address
 * and callback identity.
 *
 * Unlike the client side, Android gives a GATT server one callback object for
 * all peers. The BluetoothDevice instance supplied to each lifecycle callback
 * is therefore retained as the callback-bound identity for that connection.
 * A reconnect receives a new generation and replaces the active record for
 * the address. A late callback carrying the old device instance cannot match
 * the new active generation.
 */
internal class ServerConnectionGuard {
    private data class ActiveConnection(
        val generation: Long,
        val callbackIdentity: Any,
    )

    private val activeConnections = mutableMapOf<String, ActiveConnection>()
    private val generationsByCallbackIdentity = IdentityHashMap<Any, Long>()
    private var nextGeneration = 0L

    @Synchronized
    fun markConnected(address: String, callbackIdentity: Any): Long {
        val generation = ++nextGeneration
        val normalizedAddress = normalize(address)
        activeConnections[normalizedAddress]?.let { previous ->
            if (previous.callbackIdentity !== callbackIdentity) {
                generationsByCallbackIdentity.remove(previous.callbackIdentity)
            }
        }
        activeConnections[normalizedAddress] = ActiveConnection(generation, callbackIdentity)
        generationsByCallbackIdentity[callbackIdentity] = generation
        return generation
    }

    /**
     * Returns the generation only when this callback owns the current active
     * connection. A stale or duplicate callback returns null and must not
     * invalidate native or JavaScript state.
     */
    @Synchronized
    fun processDisconnect(address: String, callbackIdentity: Any): Long? {
        val callbackGeneration = generationsByCallbackIdentity[callbackIdentity] ?: return null
        val normalizedAddress = normalize(address)
        val active = activeConnections[normalizedAddress] ?: return null
        if (active.generation != callbackGeneration || active.callbackIdentity !== callbackIdentity) {
            return null
        }

        activeConnections.remove(normalizedAddress)
        generationsByCallbackIdentity.remove(callbackIdentity)
        return active.generation
    }

    /** Return the active generation for a current address-bound GATT request. */
    @Synchronized
    fun currentGeneration(address: String): Long? =
        activeConnections[normalize(address)]?.generation

    @Synchronized
    fun clear() {
        activeConnections.clear()
        generationsByCallbackIdentity.clear()
    }

    private fun normalize(address: String): String = address.trim().uppercase()
}
