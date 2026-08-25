import { useState, useEffect, useCallback, useRef } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';
import NativeBLE, {
  BLEDeviceFoundEvent,
  BLEScanErrorEvent,
  BLEConnectedEvent,
  BLEDisconnectedEvent,
  BLEDataReceivedEvent,
  BLEConnectionErrorEvent,
} from '../native/NativeBLE';

export type ConnectionState = 'IDLE' | 'SCANNING' | 'CONNECTING' | 'CONNECTED' | 'DISCONNECTING';

export interface DiscoveredDevice {
  deviceId: string;
  name: string | null;
  rssi: number;
  lastSeen: number;
}

/**
 * React hook for BLE discovery + GATT connection.
 *
 * Manages:
 * - bluetoothEnabled, isScanning, isAdvertising
 * - discoveredDevices
 * - connectionState, connectedDeviceId, mtu
 * - lastReceivedData, receivedDataHistory
 * - error, connectionError
 */
export function useBLE() {
  const [bluetoothEnabled, setBluetoothEnabled] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [isAdvertising, setIsAdvertising] = useState(false);
  const [discoveredDevices, setDiscoveredDevices] = useState<Map<string, DiscoveredDevice>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [localDeviceId, setLocalDeviceId] = useState<string>('');

  // V2 connection state.
  const [connectionState, setConnectionState] = useState<ConnectionState>('IDLE');
  const [connectedDeviceId, setConnectedDeviceId] = useState<string | null>(null);
  const [mtu, setMtu] = useState(23);
  const [lastReceivedData, setLastReceivedData] = useState<string | null>(null);
  const [receivedHistory, setReceivedHistory] = useState<Array<{ data: string; from: string; time: number }>>([]);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const subsRef = useRef<Array<{ remove: () => void }>>([]);

  // ── Initialise ──────────────────────────────────────────────────────

  useEffect(() => {
    const init = async () => {
      try {
        const enabled = await NativeBLE.isBluetoothEnabled();
        setBluetoothEnabled(enabled);
        const id = await NativeBLE.getDeviceId();
        setLocalDeviceId(id);
      } catch (e: any) {
        setError(e.message);
      }
    };
    init();
  }, []);

  // ── Subscribe to native events ──────────────────────────────────────

  useEffect(() => {
    // V1 discovery events.
    const deviceSub = NativeBLE.onDeviceFound((event: BLEDeviceFoundEvent) => {
      setDiscoveredDevices((prev) => {
        const next = new Map(prev);
        const existing = next.get(event.deviceId);
        next.set(event.deviceId, {
          deviceId: event.deviceId,
          name: event.name ?? existing?.name ?? null,
          rssi: event.rssi,
          lastSeen: Date.now(),
        });
        return next;
      });
    });

    const scanErrSub = NativeBLE.onScanError((event: BLEScanErrorEvent) => {
      setError(`Scan error [${event.code}]: ${event.message}`);
      setIsScanning(false);
    });

    const advStartSub = NativeBLE.onAdvertisingStarted(() => {
      setIsAdvertising(true);
    });

    const advStopSub = NativeBLE.onAdvertisingStopped(() => {
      setIsAdvertising(false);
    });

    const errSub = NativeBLE.onError((event) => {
      setError(`BLE error [${event.code}]: ${event.message}`);
    });

    // V2 connection events.
    const connectingSub = NativeBLE.onConnecting(() => {
      setConnectionState('CONNECTING');
      setConnectionError(null);
    });

    const connectedSub = NativeBLE.onConnected((event: BLEConnectedEvent) => {
      setConnectionState('CONNECTED');
      setConnectedDeviceId(event.deviceId);
      setMtu(event.mtu);
      setConnectionError(null);
    });

    const disconnectedSub = NativeBLE.onDisconnected((event: BLEDisconnectedEvent) => {
      setConnectionState('IDLE');
      setConnectedDeviceId(null);
      setMtu(23);
    });

    const dataSub = NativeBLE.onDataReceived((event: BLEDataReceivedEvent) => {
      // Decode Base64 to string for display.
      // Hermes provides atob/btoa globally but TS types don't declare them.
      let decoded: string;
      try {
        decoded = (globalThis as any).atob(event.data);
      } catch {
        decoded = event.data; // fallback: show raw Base64
      }
      setLastReceivedData(decoded);
      setReceivedHistory((prev) => [
        { data: decoded, from: event.fromDevice, time: Date.now() },
        ...prev,
      ].slice(0, 50)); // keep last 50
    });

    const connErrSub = NativeBLE.onConnectionError((event: BLEConnectionErrorEvent) => {
      setConnectionError(`Connection error [${event.code}]: ${event.message}`);
      setConnectionState('IDLE');
      setConnectedDeviceId(null);
    });

    subsRef.current = [
      deviceSub, scanErrSub, advStartSub, advStopSub, errSub,
      connectingSub, connectedSub, disconnectedSub, dataSub, connErrSub,
    ];

    return () => {
      subsRef.current.forEach((s) => s.remove());
      subsRef.current = [];
      // Stop native scanning/advertising on unmount.
      // Do NOT disconnect GATT — the explicit user action (ConnectScreen) owns that.
      NativeBLE.stopScanning().catch(() => {});
      NativeBLE.stopAdvertising().catch(() => {});
    };
  }, []);

  // ── Runtime permission request ──────────────────────────────────────

  const requestPermissions = useCallback(async (): Promise<boolean> => {
    if (Platform.OS !== 'android') return true;

    if (Platform.Version >= 31) {
      const result = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      ]);
      const allGranted = Object.values(result).every(
        (v) => v === PermissionsAndroid.RESULTS.GRANTED,
      );
      if (!allGranted) {
        setError('Bluetooth permissions denied');
        return false;
      }
      return true;
    }

    if (Platform.Version <= 30) {
      const locationResult = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      );
      if (locationResult !== PermissionsAndroid.RESULTS.GRANTED) {
        setError('Location permission denied (required for BLE scanning on this Android version)');
        return false;
      }
    }

    return true;
  }, []);

  // ── V1 Discovery actions ────────────────────────────────────────────

  const startScanning = useCallback(async () => {
    try {
      setError(null);
      setDiscoveredDevices(new Map());
      const hasPermission = await requestPermissions();
      if (!hasPermission) return;
      const enabled = await NativeBLE.isBluetoothEnabled();
      if (!enabled) {
        setError('Bluetooth is disabled');
        return;
      }
      await NativeBLE.startScanning();
      setIsScanning(true);
    } catch (e: any) {
      setError(e.message);
      setIsScanning(false);
    }
  }, [requestPermissions]);

  const stopScanning = useCallback(async () => {
    try {
      await NativeBLE.stopScanning();
      setIsScanning(false);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  const startAdvertising = useCallback(async () => {
    try {
      setError(null);
      const hasPermission = await requestPermissions();
      if (!hasPermission) return;
      const enabled = await NativeBLE.isBluetoothEnabled();
      if (!enabled) {
        setError('Bluetooth is disabled');
        return;
      }
      await NativeBLE.startAdvertising();
      setIsAdvertising(true);
    } catch (e: any) {
      setError(e.message);
      setIsAdvertising(false);
    }
  }, [requestPermissions]);

  const stopAdvertising = useCallback(async () => {
    try {
      await NativeBLE.stopAdvertising();
      setIsAdvertising(false);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  const refreshBluetoothState = useCallback(async () => {
    try {
      const enabled = await NativeBLE.isBluetoothEnabled();
      setBluetoothEnabled(enabled);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  // ── V2 GATT actions ─────────────────────────────────────────────────

  const connect = useCallback(async (deviceId: string) => {
    try {
      setConnectionError(null);
      await NativeBLE.connect(deviceId);
      // Connection state updates come via events.
    } catch (e: any) {
      setConnectionError(e.message);
      setConnectionState('IDLE');
    }
  }, []);

  const disconnect = useCallback(async () => {
    try {
      await NativeBLE.disconnect();
      setConnectionState('IDLE');
      setConnectedDeviceId(null);
      setMtu(23);
    } catch (e: any) {
      setConnectionError(e.message);
    }
  }, []);

  const send = useCallback(async (text: string) => {
    try {
      if (connectionState !== 'CONNECTED') {
        setConnectionError('Not connected');
        return;
      }
      // Encode string to Base64.
      // Hermes provides btoa globally but TS types don't declare it.
      let encoded: string;
      try {
        encoded = (globalThis as any).btoa(text);
      } catch {
        // Manual fallback: convert UTF-8 string to Base64.
        const bytes = [] as number[];
        for (let i = 0; i < text.length; i++) {
          const code = text.charCodeAt(i);
          if (code < 0x80) {
            bytes.push(code);
          } else if (code < 0x800) {
            bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
          } else {
            bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
          }
        }
        encoded = (globalThis as any).btoa(String.fromCharCode(...bytes));
      }
      await NativeBLE.send(encoded);
    } catch (e: any) {
      setConnectionError(e.message);
    }
  }, [connectionState]);

  return {
    // V1 state
    bluetoothEnabled,
    isScanning,
    isAdvertising,
    discoveredDevices,
    error,
    localDeviceId,
    // V2 state
    connectionState,
    connectedDeviceId,
    mtu,
    lastReceivedData,
    receivedHistory,
    connectionError,
    // V1 actions
    startScanning,
    stopScanning,
    startAdvertising,
    stopAdvertising,
    refreshBluetoothState,
    requestPermissions,
    // V2 actions
    connect,
    disconnect,
    send,
  };
}
