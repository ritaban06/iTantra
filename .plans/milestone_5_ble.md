# Milestone 5 — BLE Transport

## Overview

Implement phone-to-phone Bluetooth Low Energy (BLE) communication. This milestone proves that two Android devices can discover each other, connect, and exchange data — initially a simple HELLO, then actual text payloads.

BLE is the primary low-bandwidth transport for the MVP. Text payloads are transmitted, **not raw audio**.

---

## BLE Architecture

```
Phone A (Central / GATT Client)          Phone B (Peripheral / GATT Server)
                                         
startScanning()          ←→             startAdvertising()
                                         
connect(deviceId)        ──────────→    onClientConnected()
                                         
negotiateMTU(512)        ←→             MTU set
                                         
write(CHARACTERISTIC)    ──────────→    onDataReceived()
                                         
                         ←──────────    notify(CHARACTERISTIC)
```

Roles are **symmetric** — each device can act as both central and peripheral simultaneously using `BluetoothLeAdvertiser` + `BluetoothLeScanner` concurrently.

---

## BLE UUIDs (iTantra Service)

```kotlin
object iTantraBLE {
    val SERVICE_UUID     = UUID.fromString("12345678-1234-1234-1234-123456789ABC")
    val TX_CHAR_UUID     = UUID.fromString("12345678-1234-1234-1234-123456789ABD") // Central writes
    val RX_CHAR_UUID     = UUID.fromString("12345678-1234-1234-1234-123456789ABE") // Peripheral notifies
    val CCCD_UUID        = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb") // Notifications
}
```

---

## Proposed Changes

### Kotlin — BLE Layer

#### [NEW] `android/app/src/main/java/com/itantra/ble/BLEAdvertiser.kt`
```kotlin
class BLEAdvertiser(context: Context) {
    fun startAdvertising(deviceId: String)
    fun stopAdvertising()
    val isAdvertising: Boolean
}
```
- Uses `BluetoothLeAdvertiser`
- Advertises iTantra `SERVICE_UUID` + device ID in manufacturer data
- `AdvertiseSettings`: low-latency mode while active, low-power when idle
- Auto-restarts on Bluetooth toggle

#### [NEW] `android/app/src/main/java/com/itantra/ble/BLEScanner.kt`
```kotlin
class BLEScanner(context: Context) {
    fun startScanning()
    fun stopScanning()
    fun onDeviceFound(device: BLEDevice)    // callback
    val discoveredDevices: StateFlow<List<BLEDevice>>
}

data class BLEDevice(
    val bluetoothDevice: BluetoothDevice,
    val deviceId: String,       // ITN-XXXX-XXXX parsed from advertisement
    val rssi: Int,
    val lastSeen: Long
)
```
- Scans for `SERVICE_UUID`
- Deduplicates by MAC address
- Updates RSSI on re-discovery
- Stops after connection established (battery saving)

#### [NEW] `android/app/src/main/java/com/itantra/ble/BLEGattServer.kt`
```kotlin
class BLEGattServer(context: Context) : BluetoothGattServerCallback() {
    fun start()
    fun stop()
    fun sendNotification(data: ByteArray, device: BluetoothDevice)
    var onDataReceived: ((ByteArray, BluetoothDevice) -> Unit)? = null
    var onClientConnected: ((BluetoothDevice) -> Unit)? = null
    var onClientDisconnected: ((BluetoothDevice) -> Unit)? = null
}
```
- Hosts iTantra GATT service
- TX characteristic: writable (client writes data to server)
- RX characteristic: notifiable (server pushes data to client)
- Handles `onCharacteristicWriteRequest` → receives incoming data
- Sends notification on `RX_CHAR_UUID`

#### [NEW] `android/app/src/main/java/com/itantra/ble/BLEGattClient.kt`
```kotlin
class BLEGattClient(context: Context) : BluetoothGattCallback() {
    fun connect(device: BluetoothDevice)
    fun disconnect()
    fun send(data: ByteArray): Boolean
    fun requestMtu(mtu: Int = 512)
    var onConnected: (() -> Unit)? = null
    var onDisconnected: (() -> Unit)? = null
    var onDataReceived: ((ByteArray) -> Unit)? = null
    var onMtuChanged: ((Int) -> Unit)? = null
}
```
- Connects to GATT server
- Discovers services → gets TX/RX characteristics
- Enables notifications on RX characteristic
- Writes to TX characteristic to send data
- Handles MTU negotiation (512 bytes preferred, 20 bytes minimum fallback)

#### [NEW] `android/app/src/main/java/com/itantra/ble/BLEConnectionManager.kt`
```kotlin
class BLEConnectionManager(
    private val server: BLEGattServer,
    private val client: BLEGattClient,
    private val advertiser: BLEAdvertiser,
    private val scanner: BLEScanner
) {
    fun startDiscovery()
    fun connect(device: BLEDevice)
    fun disconnect()
    fun send(data: ByteArray)

    val connectionState: StateFlow<BLEState>
    val discoveredDevices: StateFlow<List<BLEDevice>>
}

enum class BLEState {
    IDLE, SCANNING, ADVERTISING, CONNECTING, CONNECTED, DISCONNECTING
}
```

#### [MODIFY] `android/app/src/main/java/com/itantra/ble/BLEModule.kt`
Full React Native TurboModule:
```kotlin
@ReactModule(name = "NativeBLE")
class BLEModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
    @ReactMethod fun startScanning(promise: Promise)
    @ReactMethod fun stopScanning(promise: Promise)
    @ReactMethod fun startAdvertising(promise: Promise)
    @ReactMethod fun stopAdvertising(promise: Promise)
    @ReactMethod fun connect(deviceId: String, promise: Promise)
    @ReactMethod fun disconnect(promise: Promise)
    @ReactMethod fun send(data: String, promise: Promise)   // base64 encoded bytes
    @ReactMethod fun getConnectionState(promise: Promise)
    @ReactMethod fun getDiscoveredDevices(promise: Promise)
    @ReactMethod fun isBluetoothEnabled(promise: Promise)
}
```
Events emitted to JS:
```
BLE_DEVICE_FOUND       { deviceId, rssi, name }
BLE_DEVICE_LOST        { deviceId }
BLE_CONNECTING         { deviceId }
BLE_CONNECTED          { deviceId, mtu }
BLE_DISCONNECTED       { deviceId, reason }
BLE_DATA_RECEIVED      { data: base64, fromDevice: deviceId }
BLE_SEND_SUCCESS       { bytesWritten }
BLE_SEND_FAILED        { error }
BLE_STATE_CHANGED      { state }
```

---

### Android Foreground Service for BLE

#### [MODIFY] `android/app/src/main/java/com/itantra/service/CommunicationService.kt`
- Android Foreground Service (required for BLE in background on Android 12+)
- Shows persistent notification: "iTantra — Connected to ITN-A7F3"
- Hosts `BLEConnectionManager`
- Survives app backgrounding

#### [NEW] `android/app/src/main/AndroidManifest.xml` additions
```xml
<uses-permission android:name="android.permission.BLUETOOTH" />
<uses-permission android:name="android.permission.BLUETOOTH_ADMIN" />
<uses-permission android:name="android.permission.BLUETOOTH_SCAN"
    android:usesPermissionFlags="neverForLocation" />
<uses-permission android:name="android.permission.BLUETOOTH_ADVERTISE" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />  <!-- Required Android 11 and below -->
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE" />

<service android:name=".service.CommunicationService"
    android:foregroundServiceType="connectedDevice" />
```

---

### JS Layer

#### [MODIFY] `src/native/NativeBLE.js`
```javascript
export default {
  startScanning: () => NativeBLE.startScanning(),
  stopScanning: () => NativeBLE.stopScanning(),
  startAdvertising: () => NativeBLE.startAdvertising(),
  connect: (deviceId) => NativeBLE.connect(deviceId),
  disconnect: () => NativeBLE.disconnect(),
  send: (base64Data) => NativeBLE.send(base64Data),
  onDeviceFound: (cb) => emitter.addListener('BLE_DEVICE_FOUND', cb),
  onConnected: (cb) => emitter.addListener('BLE_CONNECTED', cb),
  onDisconnected: (cb) => emitter.addListener('BLE_DISCONNECTED', cb),
  onDataReceived: (cb) => emitter.addListener('BLE_DATA_RECEIVED', cb),
};
```

#### [MODIFY] `src/hooks/useBLE.js`
```javascript
// Returns: { connectionState, discoveredDevices, connectedDevice,
//            startScanning, connect, disconnect, send, lastMTU }
```

#### [MODIFY] `src/screens/ConnectScreen.js`
- "Scan" button → shows discovered iTantra devices
- Device card with RSSI signal strength indicator
- Tap device → connect → show "Connected to ITN-A7F3"
- Connection status bar in header

---

## MTU & Fragmentation (Preparation)

MTU negotiation determines max packet size:
```
Preferred MTU: 512 bytes
Minimum MTU:   23 bytes (BLE spec minimum, 20 usable)
Typical MTU:   247 bytes (Android default after negotiation)
```

In this milestone: if payload > MTU, simply log warning.
Actual fragmentation is implemented in **Milestone 8**.

---

## Verification Plan

### Manual (Two Physical Android Devices)
1. Device A: open ConnectScreen → tap Scan
2. Device B: app open → auto-advertises
3. Device A sees "ITN-XXXX" in list → tap to connect
4. Both devices show "Connected"
5. Send raw "HELLO" from A → B receives and logs it
6. Disconnect → both show "Disconnected"
7. Toggle Bluetooth off/on → reconnects gracefully
8. Background app → BLE stays alive via foreground service

### Performance Targets

| Metric | Target |
|---|---|
| Discovery time | < 5 seconds |
| Connection time | < 3 seconds |
| Small payload (< 50 bytes) | < 100 ms RTT |
| BLE idle current draw | < 5 mA increase |
