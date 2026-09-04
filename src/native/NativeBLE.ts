import { NativeModules, NativeEventEmitter } from 'react-native';

const { NativeBLE } = NativeModules;
const bleEmitter = new NativeEventEmitter(NativeBLE);

// ── Event types ──────────────────────────────────────────────────────

export interface BLEDeviceFoundEvent {
  deviceId: string;
  name: string | null;
  rssi: number;
}

export interface BLEScanErrorEvent {
  code: string;
  message: string;
}

export interface BLEAdvertisingStartedEvent {
  deviceId: string;
}

export interface BLEConnectingEvent {
  deviceId: string;
}

export interface BLEConnectedEvent {
  deviceId: string;
  mtu: number;
}

export interface BLEDisconnectedEvent {
  deviceId: string;
  reason: string;
}

export interface BLEDataReceivedEvent {
  data: string; // Base64-encoded
  fromDevice: string;
}

export interface BLESendSuccessEvent {
  bytesWritten: number;
}

export interface BLESendFailedEvent {
  error: string;
}

export interface BLEConnectionErrorEvent {
  code: string;
  message: string;
}

export interface BLEErrorEvent {
  code: string;
  message: string;
}

export interface ConnectionStateInfo {
  state: 'IDLE' | 'SCANNING' | 'CONNECTING' | 'CONNECTED' | 'DISCONNECTING';
  deviceId: string;
  mtu: number;
}

// ── Module API ───────────────────────────────────────────────────────

export default {
  // ── V1 Discovery methods ───────────────────────────────────────────

  getDeviceId: (): Promise<string> => NativeBLE.getDeviceId(),

  isBluetoothEnabled: (): Promise<boolean> => NativeBLE.isBluetoothEnabled(),

  getMissingPermissions: (): Promise<string[]> => NativeBLE.getMissingPermissions(),

  startScanning: (): Promise<boolean> => NativeBLE.startScanning(),

  stopScanning: (): Promise<boolean> => NativeBLE.stopScanning(),

  isScanning: (): Promise<boolean> => NativeBLE.isScanning(),

  startAdvertising: (): Promise<boolean> => NativeBLE.startAdvertising(),

  stopAdvertising: (): Promise<boolean> => NativeBLE.stopAdvertising(),

  isAdvertising: (): Promise<boolean> => NativeBLE.isAdvertising(),

  // ── V2 GATT methods ───────────────────────────────────────────────

  connect: (deviceId: string): Promise<boolean> => NativeBLE.connect(deviceId),

  disconnect: (deviceId?: string): Promise<boolean> =>
    deviceId ? NativeBLE.disconnect({ deviceId }) : NativeBLE.disconnect(),

  /**
   * Send data to a connected peer.
   * @param base64Data Base64-encoded bytes to send.
   * @param deviceId Optional target peer ID. If omitted, sends to legacy connected peer.
   */
  send: (base64Data: string, deviceId?: string): Promise<boolean> =>
    deviceId ? NativeBLE.send(base64Data, { deviceId }) : NativeBLE.send(base64Data),

  getConnectionState: (deviceId?: string): Promise<ConnectionStateInfo> =>
    deviceId ? NativeBLE.getConnectionState({ deviceId }) : NativeBLE.getConnectionState(),

  // ── V1 Event listeners ─────────────────────────────────────────────

  onDeviceFound: (cb: (event: BLEDeviceFoundEvent) => void) =>
    bleEmitter.addListener('BLE_DEVICE_FOUND', cb),

  onScanError: (cb: (event: BLEScanErrorEvent) => void) =>
    bleEmitter.addListener('BLE_SCAN_ERROR', cb),

  onAdvertisingStarted: (cb: (event: BLEAdvertisingStartedEvent) => void) =>
    bleEmitter.addListener('BLE_ADVERTISING_STARTED', cb),

  onAdvertisingStopped: (cb: () => void) =>
    bleEmitter.addListener('BLE_ADVERTISING_STOPPED', cb),

  onError: (cb: (event: BLEErrorEvent) => void) =>
    bleEmitter.addListener('BLE_ERROR', cb),

  // ── V2 Connection event listeners ──────────────────────────────────

  onConnecting: (cb: (event: BLEConnectingEvent) => void) =>
    bleEmitter.addListener('BLE_CONNECTING', cb),

  onConnected: (cb: (event: BLEConnectedEvent) => void) =>
    bleEmitter.addListener('BLE_CONNECTED', cb),

  onDisconnected: (cb: (event: BLEDisconnectedEvent) => void) =>
    bleEmitter.addListener('BLE_DISCONNECTED', cb),

  onDataReceived: (cb: (event: BLEDataReceivedEvent) => void) =>
    bleEmitter.addListener('BLE_DATA_RECEIVED', cb),

  onSendSuccess: (cb: (event: BLESendSuccessEvent) => void) =>
    bleEmitter.addListener('BLE_SEND_SUCCESS', cb),

  onSendFailed: (cb: (event: BLESendFailedEvent) => void) =>
    bleEmitter.addListener('BLE_SEND_FAILED', cb),

  onConnectionError: (cb: (event: BLEConnectionErrorEvent) => void) =>
    bleEmitter.addListener('BLE_CONNECTION_ERROR', cb),
};
