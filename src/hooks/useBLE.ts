import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';
import NativeBLE, {
  BLEDeviceFoundEvent,
  BLEScanErrorEvent,
  BLEConnectingEvent,
  BLEConnectedEvent,
  BLEDisconnectedEvent,
  BLEDataReceivedEvent,
  BLEConnectionErrorEvent,
} from '../native/NativeBLE';

export type ConnectionState = 'IDLE' | 'SCANNING' | 'CONNECTING' | 'CONNECTED' | 'DISCONNECTING';

/** Whether a BLE connection was initiated locally (CLIENT) or accepted from a remote device (SERVER). */
export type PeerRole = 'CLIENT' | 'SERVER';

/**
 * Per-peer BLE connection state.
 *
 * Each BLE peer (identified by its iTantra deviceId) tracks its own
 * connection state, MTU, and (when known) role. Mutating one peer's
 * entry never affects another peer's entry.
 */
export interface PeerBLEState {
  deviceId: string;
  state: ConnectionState;
  mtu: number;
  role?: PeerRole;
}

export interface DiscoveredDevice {
  deviceId: string;
  name: string | null;
  rssi: number;
  lastSeen: number;
}

/**
 * Derive the legacy single-peer connection view from the per-peer map.
 *
 * Mirrors the native BLEConnectionManager.syncLegacyState() policy:
 * the first CONNECTED peer is reflected; otherwise the first
 * CONNECTING/DISCONNECTING peer; otherwise IDLE with no device.
 *
 * These are compatibility views only — the peers map is the source of truth.
 */
function deriveLegacyState(peers: ReadonlyMap<string, PeerBLEState>): {
  connectionState: ConnectionState;
  connectedDeviceId: string | null;
  mtu: number;
} {
  const entries = Array.from(peers.values());
  const connected = entries.find((p) => p.state === 'CONNECTED');
  if (connected) {
    return {
      connectionState: connected.state,
      connectedDeviceId: connected.deviceId,
      mtu: connected.mtu,
    };
  }
  const active = entries.find(
    (p) => p.state === 'CONNECTING' || p.state === 'DISCONNECTING',
  );
  if (active) {
    return {
      connectionState: active.state,
      connectedDeviceId: active.deviceId,
      mtu: active.mtu,
    };
  }
  return { connectionState: 'IDLE', connectedDeviceId: null, mtu: 23 };
}

/** Encode a UTF-8 string to Base64. Hermes provides btoa but TS types don't declare it. */
function encodeTextToBase64(text: string): string {
  try {
    return (globalThis as any).btoa(text);
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
        bytes.push(
          0xe0 | (code >> 12),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f),
        );
      }
    }
    return (globalThis as any).btoa(String.fromCharCode(...bytes));
  }
}

/**
 * React hook for BLE discovery + GATT connection.
 *
 * Manages:
 * - bluetoothEnabled, isScanning, isAdvertising
 * - discoveredDevices
 * - peers: Map<deviceId, PeerBLEState>  ← per-peer connection state (source of truth)
 * - connectionState, connectedDeviceId, mtu  ← legacy views derived from peers
 * - lastReceivedData, receivedDataHistory
 * - error, connectionError
 *
 * V9E Step 5: peer-aware state. The BLE transport can maintain several
 * simultaneous peers (client and/or server); each peer is tracked
 * independently and one peer's connect/disconnect never affects another.
 */
export function useBLE() {
  const [bluetoothEnabled, setBluetoothEnabled] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [isAdvertising, setIsAdvertising] = useState(false);
  const [discoveredDevices, setDiscoveredDevices] = useState<Map<string, DiscoveredDevice>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [localDeviceId, setLocalDeviceId] = useState<string>('');

  // Per-peer connection state — the JS source of truth for BLE connections.
  const [peers, setPeers] = useState<Map<string, PeerBLEState>>(new Map());
  // Per-peer mutation watermarks protect asynchronous native hydration from
  // overwriting newer connection events or actions.
  const peerMutationVersionsRef = useRef<Map<string, number>>(new Map());
  const peerMapClearVersionRef = useRef(0);

  const notePeerMutation = useCallback((deviceId: string): void => {
    const versions = peerMutationVersionsRef.current;
    versions.set(deviceId, (versions.get(deviceId) ?? 0) + 1);
  }, []);

  const [lastReceivedData, setLastReceivedData] = useState<string | null>(null);
  const [receivedHistory, setReceivedHistory] = useState<Array<{ data: string; from: string; time: number }>>([]);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const subsRef = useRef<Array<{ remove: () => void }>>([]);

  /**
   * deviceIds with an in-flight connect() call that has not yet been
   * confirmed by a BLE_CONNECTED / BLE_DISCONNECTED event. Used to clean
   * up optimistic CONNECTING entries when a native connection error
   * arrives without peer attribution.
   */
  const pendingConnectsRef = useRef<Set<string>>(new Set());

  // Legacy single-peer compatibility views (derived, NOT the source of truth).
  const legacy = useMemo(() => deriveLegacyState(peers), [peers]);
  const { connectionState, connectedDeviceId, mtu } = legacy;

  // ── Initialise ──────────────────────────────────────────────────────

  useEffect(() => {
    const init = async () => {
      try {
        const enabled = await NativeBLE.isBluetoothEnabled();
        setBluetoothEnabled(enabled);
        const id = await NativeBLE.getDeviceId();
        setLocalDeviceId(id);

        // Discovery and Home are separate hook instances. Hydrate Home from
        // the native source of truth so a connection made before navigation
        // is not rendered as disconnected and cannot diverge from send().
        const getConnectedDeviceIds = (NativeBLE as any).getConnectedDeviceIds;
        if (typeof getConnectedDeviceIds === 'function') {
          try {
            const hydrationVersions = new Map(peerMutationVersionsRef.current);
            const hydrationClearVersion = peerMapClearVersionRef.current;
            const ids = await getConnectedDeviceIds();
            const connected = Array.isArray(ids) ? ids : [];
            console.log(
              `[ITANTRA_CONN] JS event=HYDRATION nativeConnectedDeviceIds=[${connected.join(',')}]`,
            );
            const hydrated = await Promise.all(connected.map(async (deviceId: string) => {
              try {
                const info = await NativeBLE.getConnectionState(deviceId);
                if (info?.state && info.state !== 'CONNECTED') return null;
                return {
                  deviceId,
                  state: 'CONNECTED' as ConnectionState,
                  mtu: info?.mtu ?? 23,
                  role: info?.role as PeerRole | undefined,
                };
              } catch {
                return { deviceId, state: 'CONNECTED' as ConnectionState, mtu: 23 };
              }
            }));
            const hydratedById = new Map(
              hydrated
                .filter((peer): peer is PeerBLEState => peer !== null)
                .map((peer) => [peer.deviceId, peer]),
            );
            const connectedIds = new Set(connected);
            setPeers((prev) => {
              if (peerMapClearVersionRef.current !== hydrationClearVersion) return prev;

              const next = new Map(prev);
              for (const [deviceId, peer] of hydratedById) {
                const changedAfterSnapshot =
                  (peerMutationVersionsRef.current.get(deviceId) ?? 0) !==
                  (hydrationVersions.get(deviceId) ?? 0);
                if (!changedAfterSnapshot) next.set(deviceId, peer);
              }
              for (const deviceId of prev.keys()) {
                const changedAfterSnapshot =
                  (peerMutationVersionsRef.current.get(deviceId) ?? 0) !==
                  (hydrationVersions.get(deviceId) ?? 0);
                if (!connectedIds.has(deviceId) && !changedAfterSnapshot) {
                  next.delete(deviceId);
                }
              }
              return next;
            });
          } catch {
            // Older native modules may not expose the reconciliation method.
          }
        }
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

    // V2 connection events — each handler touches only the peer named by
    // the event so one peer's lifecycle never overwrites another's state.
    const connectingSub = NativeBLE.onConnecting((event: BLEConnectingEvent) => {
      setConnectionError(null);
      notePeerMutation(event.deviceId);
      setPeers((prev) => {
        const existing = prev.get(event.deviceId);
        if (existing && existing.state === 'CONNECTED') return prev;
        const next = new Map(prev);
        next.set(event.deviceId, {
          deviceId: event.deviceId,
          state: 'CONNECTING',
          mtu: existing?.mtu ?? 23,
          role: existing?.role ?? 'CLIENT',
        });
        return next;
      });
    });

    const connectedSub = NativeBLE.onConnected((event: BLEConnectedEvent) => {
      pendingConnectsRef.current.delete(event.deviceId);
      setConnectionError(null);
      notePeerMutation(event.deviceId);
      console.log(`[ITANTRA_CONN] JS event=BLE_CONNECTED deviceId=${event.deviceId}`);
      setPeers((prev) => {
        const existing = prev.get(event.deviceId);
        const next = new Map(prev);
        next.set(event.deviceId, {
          deviceId: event.deviceId,
          state: 'CONNECTED',
          mtu: event.mtu,
          role: existing?.role,
        });
        return next;
      });
    });

    const disconnectedSub = NativeBLE.onDisconnected((event: BLEDisconnectedEvent) => {
      pendingConnectsRef.current.delete(event.deviceId);
      notePeerMutation(event.deviceId);
      console.log(
        `[ITANTRA_CONN] JS event=BLE_DISCONNECTED deviceId=${event.deviceId} reason=${event.reason}`,
      );
      setPeers((prev) => {
        if (!prev.has(event.deviceId)) return prev;
        const next = new Map(prev);
        next.delete(event.deviceId);
        return next;
      });
    });

    const dataSub = NativeBLE.onDataReceived((event: BLEDataReceivedEvent) => {
      // Decode Base64 to string for display.
      // The originating peer (event.fromDevice) is preserved verbatim —
      // never substitute the legacy connectedDeviceId here.
      let decoded: string;
      try {
        decoded = (globalThis as any).atob(event.data);
      } catch {
        decoded = event.data; // fallback: show raw Base64
      }
      setLastReceivedData(decoded);
      setReceivedHistory((prev) =>
        [{ data: decoded, from: event.fromDevice, time: Date.now() }, ...prev].slice(0, 50), // keep last 50
      );
    });

    const connErrSub = NativeBLE.onConnectionError((event: BLEConnectionErrorEvent) => {
      setConnectionError(`Connection error [${event.code}]: ${event.message}`);
      // The native error event carries no peer id, so only clean up an
      // in-flight connection attempt when exactly one is pending (i.e. the
      // affected peer is unambiguous). A peer that failed mid-session is
      // reconciled by the BLE_DISCONNECTED event that follows most native
      // error paths; never clear the whole peers map here.
      const pending = Array.from(pendingConnectsRef.current);
      if (pending.length === 1) {
        const peerId = pending[0];
        pendingConnectsRef.current.delete(peerId);
        notePeerMutation(peerId);
        setPeers((prev) => {
          const existing = prev.get(peerId);
          if (!existing || existing.state !== 'CONNECTING') return prev;
          const next = new Map(prev);
          next.delete(peerId);
          return next;
        });
      }
    });

    subsRef.current = [
      deviceSub, scanErrSub, advStartSub, advStopSub, errSub,
      connectingSub, connectedSub, disconnectedSub, dataSub, connErrSub,
    ];

    return () => {
      subsRef.current.forEach((s) => s.remove());
      subsRef.current = [];
      pendingConnectsRef.current.clear();
      // Stop native scanning/advertising on unmount.
      // Do NOT disconnect GATT — the explicit user action (ConnectScreen) owns that.
      NativeBLE.stopScanning().catch(() => {});
      NativeBLE.stopAdvertising().catch(() => {});
    };
  }, [notePeerMutation]);

  // ── Runtime permission request ──────────────────────────────────────

  const requestPermissions = useCallback(async (): Promise<boolean> => {
    if (Platform.OS !== 'android') return true;

    if (Platform.Version >= 31) {
      const result = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      ]);
      const allGranted = Object.values(result).every(
        (v) => v === PermissionsAndroid.RESULTS.GRANTED,
      );
      if (!allGranted) {
        setError('Bluetooth/Location permissions denied');
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

  // ── V2 GATT actions (peer-aware) ────────────────────────────────────

  /**
   * Connect to a discovered device by its iTantra device ID.
   *
   * Connecting to a new peer is allowed even when another peer is already
   * connected. The peer is optimistically marked CONNECTING; the actual
   * result arrives via BLE_CONNECTED / BLE_DISCONNECTED events.
   */
  const connect = useCallback(async (deviceId: string) => {
    try {
      setConnectionError(null);
      notePeerMutation(deviceId);
      setPeers((prev) => {
        const existing = prev.get(deviceId);
        if (existing && (existing.state === 'CONNECTED' || existing.state === 'CONNECTING')) {
          return prev;
        }
        const next = new Map(prev);
        next.set(deviceId, {
          deviceId,
          state: 'CONNECTING',
          mtu: existing?.mtu ?? 23,
          role: existing?.role ?? 'CLIENT',
        });
        return next;
      });
      pendingConnectsRef.current.add(deviceId);
      await NativeBLE.connect(deviceId);
      // Connection state updates come via BLE_CONNECTED events.
    } catch (e: any) {
      pendingConnectsRef.current.delete(deviceId);
      setConnectionError(e.message);
      // If the native layer refused because a connection already exists or
      // is already in progress, leave the peer state alone — events will
      // reconcile it. Otherwise revert our optimistic CONNECTING entry.
      const code: string | undefined = e?.code;
      if (code === 'ALREADY_CONNECTED' || code === 'ALREADY_CONNECTING') return;
      notePeerMutation(deviceId);
      setPeers((prev) => {
        const existing = prev.get(deviceId);
        if (!existing || existing.state !== 'CONNECTING') return prev;
        const next = new Map(prev);
        next.delete(deviceId);
        return next;
      });
    }
  }, [notePeerMutation]);

  /**
   * Disconnect one peer, or all peers when deviceId is omitted (legacy).
   *
   * The native manager removes the peer synchronously and does not emit a
   * BLE_DISCONNECTED event for explicit disconnects, so the peer state is
   * cleared optimistically. Other peers are untouched.
   */
  const disconnect = useCallback(async (deviceId?: string) => {
    try {
      if (deviceId) {
        notePeerMutation(deviceId);
        await NativeBLE.disconnect(deviceId);
        pendingConnectsRef.current.delete(deviceId);
        setPeers((prev) => {
          if (!prev.has(deviceId)) return prev;
          const next = new Map(prev);
          next.delete(deviceId);
          return next;
        });
      } else {
        await NativeBLE.disconnect();
        pendingConnectsRef.current.clear();
        peerMapClearVersionRef.current += 1;
        setPeers(new Map());
      }
    } catch (e: any) {
      setConnectionError(e.message);
    }
  }, [notePeerMutation]);

  /**
   * Send data to a specific peer, or to the legacy connected peer when
   * deviceId is omitted. A requested peer-targeted send never redirects to
   * another peer.
   */
  const send = useCallback(
    async (text: string, deviceId?: string) => {
      try {
        const targetId = deviceId ?? connectedDeviceId;
        if (!targetId) {
          setConnectionError('Not connected');
          return;
        }
        const target = peers.get(targetId);
        if (!target || target.state !== 'CONNECTED') {
          setConnectionError(`Not connected to ${targetId}`);
          return;
        }
        // Encode string to Base64.
        const encoded = encodeTextToBase64(text);
        await NativeBLE.send(encoded, targetId);
      } catch (e: any) {
        setConnectionError(e.message);
      }
    },
    [connectedDeviceId, peers],
  );

  return {
    // V1 state
    bluetoothEnabled,
    isScanning,
    isAdvertising,
    discoveredDevices,
    error,
    localDeviceId,
    // V2 per-peer state (source of truth)
    peers,
    // V2 legacy single-peer views (derived from peers)
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
