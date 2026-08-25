# Milestone 9 — Wi-Fi Direct Transport

## Overview

Add Wi-Fi Direct as a second high-bandwidth transport. The message layer (protocol, encryption, reliability) remains unchanged — only the transport layer gains a new implementation. The `TransportManager` automatically selects BLE or Wi-Fi Direct based on availability and preference.

Wi-Fi Direct offers significantly higher bandwidth (up to ~250 Mbps) and longer range (~200m) compared to BLE, making it ideal for larger messages and lower latency when available.

---

## Transport Abstraction (Finalized)

```kotlin
interface Transport {
    fun connect(peer: Peer)
    fun disconnect()
    fun send(data: ByteArray): Boolean
    fun getStatus(): TransportStatus
    val onDataReceived: Flow<ByteArray>
    val onStatusChanged: Flow<TransportStatus>
}

enum class TransportStatus { IDLE, DISCOVERING, CONNECTING, CONNECTED, DISCONNECTING, ERROR }

data class Peer(
    val id: String,                      // iTantra device ID
    val displayName: String,
    val bleDevice: BluetoothDevice?,     // null if Wi-Fi only
    val wifiDevice: WifiP2pDevice?       // null if BLE only
)
```

Implementations:
```
BLETransport         implements Transport
WifiDirectTransport  implements Transport
```

---

## Proposed Changes

### Kotlin

#### [NEW] `android/app/src/main/java/com/itantra/wifi/WifiDirectManager.kt`
```kotlin
class WifiDirectManager(
    private val context: Context,
    private val scope: CoroutineScope
) : BroadcastReceiver() {

    private val wifiP2pManager: WifiP2pManager
    private val channel: WifiP2pManager.Channel

    fun initialize()
    fun startDiscovery()
    fun stopDiscovery()
    fun connectToPeer(device: WifiP2pDevice)
    fun createGroup()            // Act as Group Owner (GO)
    fun removeGroup()
    fun disconnect()
    fun requestConnectionInfo(): Flow<WifiP2pInfo>

    // BroadcastReceiver for Wi-Fi P2P state changes
    override fun onReceive(context: Context, intent: Intent)

    val discoveredPeers: StateFlow<List<WifiP2pDevice>>
    val connectionInfo: StateFlow<WifiP2pInfo?>
    val p2pState: StateFlow<WiFiP2pState>
}
```

Handles intents:
- `WIFI_P2P_STATE_CHANGED_ACTION`
- `WIFI_P2P_PEERS_CHANGED_ACTION`
- `WIFI_P2P_CONNECTION_CHANGED_ACTION`
- `WIFI_P2P_THIS_DEVICE_CHANGED_ACTION`

#### [NEW] `android/app/src/main/java/com/itantra/wifi/WifiDirectServer.kt`
```kotlin
class WifiDirectServer(private val port: Int = 8888) {
    suspend fun start(): Flow<WifiDirectMessage>
    fun stop()
    val isRunning: Boolean
}
```
- `ServerSocket` on port 8888 (only local network, no Internet)
- Accepts one client at a time (point-to-point)
- Each message: 4-byte length prefix + payload bytes
- Runs in coroutine on `Dispatchers.IO`

#### [NEW] `android/app/src/main/java/com/itantra/wifi/WifiDirectClient.kt`
```kotlin
class WifiDirectClient {
    suspend fun connect(hostAddress: String, port: Int = 8888)
    suspend fun send(data: ByteArray): Boolean
    fun disconnect()
    val onDataReceived: Flow<ByteArray>
}
```
- TCP `Socket` to Group Owner's IP address
- Length-prefixed framing (same as server)
- Auto-reconnect on connection drop (3 retries)

#### [NEW] `android/app/src/main/java/com/itantra/wifi/WifiDirectTransport.kt`
```kotlin
class WifiDirectTransport(
    private val wifiManager: WifiDirectManager,
    private val server: WifiDirectServer,
    private val client: WifiDirectClient
) : Transport {
    override fun connect(peer: Peer) {
        // 1. WifiP2pManager.connect(peer.wifiDevice)
        // 2. Wait for WIFI_P2P_CONNECTION_CHANGED_ACTION
        // 3. requestConnectionInfo → determine if Group Owner or Client
        // 4. If GO → start WifiDirectServer
        // 5. If Client → WifiDirectClient.connect(goAddress)
    }
    override fun send(data: ByteArray): Boolean
    override fun disconnect()
    override val onDataReceived: Flow<ByteArray>
    override val onStatusChanged: Flow<TransportStatus>
}
```

#### [MODIFY] `android/app/src/main/java/com/itantra/transport/TransportManager.kt`
```kotlin
class TransportManager(
    private val bleTransport: BLETransport,
    private val wifiTransport: WifiDirectTransport
) {
    private var activeTransport: Transport = bleTransport

    fun selectTransport(preference: TransportPreference) {
        activeTransport = when (preference) {
            BLE_PREFERRED    -> if (bleTransport.isAvailable()) bleTransport else wifiTransport
            WIFI_PREFERRED   -> if (wifiTransport.isAvailable()) wifiTransport else bleTransport
            AUTO             -> selectBestAvailable()
        }
    }

    private fun selectBestAvailable(): Transport {
        return if (wifiTransport.isAvailable()) wifiTransport else bleTransport
    }

    fun send(data: ByteArray) = activeTransport.send(data)
    val onDataReceived = merge(bleTransport.onDataReceived, wifiTransport.onDataReceived)
    val activeTransportType: TransportType get() = when (activeTransport) {
        is BLETransport       -> TransportType.BLE
        is WifiDirectTransport -> TransportType.WIFI_DIRECT
        else -> TransportType.NONE
    }
}
```

#### [MODIFY] `android/app/src/main/java/com/itantra/wifi/WifiDirectModule.kt`
React Native TurboModule:
```kotlin
@ReactModule(name = "NativeWifiDirect")
class WifiDirectModule(...) : ReactContextBaseJavaModule(...) {
    @ReactMethod fun startDiscovery(promise: Promise)
    @ReactMethod fun stopDiscovery(promise: Promise)
    @ReactMethod fun connect(deviceName: String, promise: Promise)
    @ReactMethod fun disconnect(promise: Promise)
    @ReactMethod fun getDiscoveredPeers(promise: Promise)
    @ReactMethod fun getConnectionInfo(promise: Promise)
    @ReactMethod fun isWifiDirectAvailable(promise: Promise)
}
```
Events:
```
WIFI_PEER_FOUND          { deviceName, deviceAddress }
WIFI_PEER_LOST           { deviceName }
WIFI_CONNECTING          { deviceName }
WIFI_CONNECTED           { deviceName, isGroupOwner, groupOwnerAddress }
WIFI_DISCONNECTED        { reason }
WIFI_DATA_RECEIVED       { data: base64 }
WIFI_STATE_CHANGED       { state }
```

---

### Android Permissions

```xml
<uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
<uses-permission android:name="android.permission.CHANGE_WIFI_STATE" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.CHANGE_NETWORK_STATE" />
<uses-permission android:name="android.permission.INTERNET" />
<!-- Note: INTERNET is required for TCP socket even on local P2P network -->
```

> [!IMPORTANT]
> The `INTERNET` permission is required for TCP sockets even on a Wi-Fi Direct local network. This does NOT enable cloud access — the app still never makes any external network requests.

---

### JS Layer

#### [MODIFY] `src/native/NativeWifiDirect.js`
```javascript
export default {
  startDiscovery: () => NativeWifiDirect.startDiscovery(),
  connect: (deviceName) => NativeWifiDirect.connect(deviceName),
  disconnect: () => NativeWifiDirect.disconnect(),
  getDiscoveredPeers: () => NativeWifiDirect.getDiscoveredPeers(),
  isWifiDirectAvailable: () => NativeWifiDirect.isWifiDirectAvailable(),
  onPeerFound: (cb) => emitter.addListener('WIFI_PEER_FOUND', cb),
  onConnected: (cb) => emitter.addListener('WIFI_CONNECTED', cb),
  onDisconnected: (cb) => emitter.addListener('WIFI_DISCONNECTED', cb),
  onDataReceived: (cb) => emitter.addListener('WIFI_DATA_RECEIVED', cb),
};
```

#### [MODIFY] `src/screens/ConnectScreen.js`
```
Transport Selection:
  ○ Auto (recommended)
  ○ BLE only
  ○ Wi-Fi Direct only

Active Transport: [BLE] / [Wi-Fi Direct]
```

#### [MODIFY] `src/screens/BenchmarkScreen.js`
```
Transport: Wi-Fi Direct
Bandwidth: 1.2 MB/s
RTT: 12 ms
```

---

## Wi-Fi Direct Group Owner Election

Android automatically elects the Group Owner (GO) during connection. The GO acts as the TCP server. Determination:
```
If GO → start WifiDirectServer (TCP ServerSocket)
If Client → connect to GO's IP via WifiDirectClient
```
GO's IP is typically `192.168.49.1` (Android standard for P2P GO).

---

## Verification Plan

### Manual (Two Physical Devices Required)
1. Enable Wi-Fi Direct on both devices
2. Connect → confirm Wi-Fi Direct connection (not BLE)
3. Send message → verify arrives correctly
4. Verify payload is identical to BLE path (same encryption, same protocol)
5. Switch back to BLE → message layer continues without restart
6. Disable Wi-Fi → auto-fallback to BLE
7. BenchmarkScreen shows Wi-Fi Direct transport type

### Performance Comparison

| Metric | BLE | Wi-Fi Direct |
|---|---|---|
| Max throughput | ~2 KB/s useful | ~250 Mbps |
| Range | ~30m indoor | ~200m |
| Connection time | ~2s | ~3-5s |
| Power (idle) | Low | Higher |
| Setup complexity | Low | Medium |

Wi-Fi Direct recommended for: large payloads, multiple rapid messages, future audio streaming research.
BLE recommended for: MVP, maximum battery efficiency, short emergency text.
