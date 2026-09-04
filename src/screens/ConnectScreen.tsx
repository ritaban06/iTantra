import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useBLE, DiscoveredDevice, PeerBLEState } from '../hooks/useBLE';
import {
  MeshDestination,
  getMeshDestinations,
  getVoiceDestinationNodeId,
  setVoiceDestinationNodeId,
  subscribeMeshDestinations,
  subscribeVoiceDestination,
} from '../hooks/voiceDestinationStore';
import { NODE_ID_BROADCAST } from '../BITCHAT';

/**
 * A single device row combining the discovered-device info (name/RSSI)
 * with the per-peer connection state from useBLE (state/MTU/role).
 */
interface PeerRow {
  deviceId: string;
  name: string | null;
  rssi: number;
  state: PeerBLEState['state'] | 'IDLE';
  mtu: number;
  role?: PeerBLEState['role'];
}

export default function ConnectScreen() {
  const {
    bluetoothEnabled,
    isScanning,
    isAdvertising,
    discoveredDevices,
    error,
    localDeviceId,
    peers,
    // Legacy single-peer views (derived from peers) — kept for the
    // single-peer diagnostics box and status bar only.
    connectionState,
    connectedDeviceId,
    mtu,
    lastReceivedData,
    connectionError,
    startScanning,
    stopScanning,
    startAdvertising,
    stopAdvertising,
    refreshBluetoothState,
    connect,
    disconnect,
  } = useBLE();

  // V9E Step 10: logical voice destination (BITCHAT nodeId). This is the
  // mesh/network identity — deliberately separate from Bluetooth deviceIds.
  // The value lives in the shared store (module-level) so the voice hook
  // (HomeScreen) and this screen stay in sync without lifting state.
  const [voiceDestination, setVoiceDestinationState] = useState<string>(
    getVoiceDestinationNodeId(),
  );
  const [meshDestinations, setMeshDestinations] = useState<MeshDestination[]>(
    getMeshDestinations(),
  );

  useEffect(() => {
    refreshBluetoothState();
    // Subscribe to the shared destination + mesh-destination stores. The
    // subscription is mounted once and updates local state, so the screen
    // reflects destination changes made anywhere (e.g. in the voice hook).
    const unsubDest = subscribeVoiceDestination((dest) => {
      setVoiceDestinationState(dest);
    });
    const unsubMesh = subscribeMeshDestinations(() => {
      setMeshDestinations(getMeshDestinations());
    });
    return () => {
      unsubDest();
      unsubMesh();
    };
  }, []);

  const handleSelectDestination = (nodeId: string) => {
    setVoiceDestinationNodeId(nodeId);
  };

  // Destination list: broadcast first, then direct peers, then discovered
  // (possibly multi-hop) nodes. Each entry is a BITCHAT nodeId.
  const destinationRows: Array<{ nodeId: string; label: string; kind: 'broadcast' | 'direct' | 'mesh' }> = [
    { nodeId: NODE_ID_BROADCAST, label: 'Broadcast (all nodes)', kind: 'broadcast' },
    ...meshDestinations
      .filter((d) => d.nodeId !== NODE_ID_BROADCAST)
      .map((d) => ({
        nodeId: d.nodeId,
        label: d.direct ? `${d.nodeId} (direct)` : `${d.nodeId} (mesh)`,
        kind: (d.direct ? 'direct' : 'mesh') as 'direct' | 'mesh',
      })),
  ];

  useEffect(() => {
    if (bluetoothEnabled && !isAdvertising) {
      startAdvertising();
    }
  }, [bluetoothEnabled]);

  /**
   * Build the full peer list. Connected peers come from the useBLE peers
   * map (so server-side peers that may not be in the scan results still
   * appear); discovered devices come from the scanner. A discovered device
   * that is not connected shows as an available peer.
   */
  const peerRows: PeerRow[] = (() => {
    const rows = new Map<string, PeerRow>();
    const discovered = Array.from(discoveredDevices.values());

    // Connected / connecting peers first (source of truth for connection).
    Array.from(peers.values()).forEach((p) => {
      rows.set(p.deviceId, {
        deviceId: p.deviceId,
        name: discoveredDevices.get(p.deviceId)?.name ?? null,
        rssi: discoveredDevices.get(p.deviceId)?.rssi ?? -100,
        state: p.state,
        mtu: p.mtu,
        role: p.role,
      });
    });

    // Discovered devices that are not in the peer map → available.
    discovered.forEach((d) => {
      if (!rows.has(d.deviceId)) {
        rows.set(d.deviceId, {
          deviceId: d.deviceId,
          name: d.name,
          rssi: d.rssi,
          state: 'IDLE',
          mtu: 23,
        });
      }
    });

    // Connected/connecting first, then by RSSI descending.
    return Array.from(rows.values()).sort((a, b) => {
      const aActive = a.state === 'CONNECTED' || a.state === 'CONNECTING';
      const bActive = b.state === 'CONNECTED' || b.state === 'CONNECTING';
      if (aActive !== bActive) return aActive ? -1 : 1;
      return b.rssi - a.rssi;
    });
  })();

  const connectedCount = Array.from(peers.values()).filter(
    (p) => p.state === 'CONNECTED',
  ).length;
  // Rows that are not yet connected/connecting are the AVAILABLE devices.
  const availableCount = peerRows.filter(
    (r) => r.state !== 'CONNECTED' && r.state !== 'CONNECTING',
  ).length;

  const handleScanToggle = () => {
    if (isScanning) stopScanning();
    else startScanning();
  };

  /**
   * Per-peer connect/disconnect. The action affects ONLY the device whose
   * button was pressed — other peers are never touched.
   */
  const handleConnect = (deviceId: string) => {
    const peer = peers.get(deviceId);
    if (peer && peer.state === 'CONNECTED') {
      disconnect(deviceId);
    } else {
      connect(deviceId);
    }
  };

  const getConnectionLabel = (row: PeerRow): string => {
    if (row.state === 'CONNECTED') return 'DISCONNECT';
    if (row.state === 'CONNECTING') return 'CONNECTING...';
    return 'CONNECT';
  };

  const renderPeerCard = ({ item }: { item: PeerRow }) => {
    const isConnected = item.state === 'CONNECTED';
    const isConnecting = item.state === 'CONNECTING';
    const isDisconnecting = item.state === 'DISCONNECTING';

    return (
      <View
        style={[
          styles.deviceCard,
          isConnected && styles.deviceCardConnected,
          isConnecting && styles.deviceCardPending,
        ]}
        testID={`peer-row-${item.deviceId}`}
      >
        <View style={styles.deviceInfo}>
          <View style={styles.deviceNameRow}>
            <Text style={styles.deviceName}>{item.deviceId}</Text>
            <Text
              style={[
                styles.stateBadge,
                isConnected ? styles.stateBadgeConnected : styles.stateBadgeIdle,
                isConnecting && styles.stateBadgeConnecting,
              ]}
            >
              {isConnected ? 'CONNECTED' : isConnecting ? 'CONNECTING' : 'DISCOVERED'}
            </Text>
          </View>
          {item.name ? <Text style={styles.deviceSubtitle}>{item.name}</Text> : null}

          <View style={styles.metaRow}>
            {isConnected || isConnecting ? (
              <>
                {item.role ? (
                  <Text style={styles.metaText}>{item.role}</Text>
                ) : null}
                <Text style={styles.metaText}>MTU {item.mtu}</Text>
              </>
            ) : (
              <Text style={styles.deviceRssi}>{item.rssi} dBm</Text>
            )}
          </View>
        </View>

        <TouchableOpacity
          style={[
            styles.connectBtn,
            isConnected && styles.connectBtnActive,
            isConnecting && styles.connectBtnPending,
            isDisconnecting && styles.connectBtnPending,
          ]}
          onPress={() => handleConnect(item.deviceId)}
          disabled={isConnecting || isDisconnecting}
          testID={`peer-action-${item.deviceId}`}
        >
          {isConnecting || isDisconnecting ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.connectBtnText}>{getConnectionLabel(item)}</Text>
          )}
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* Header */}
        <View style={styles.header}>
          <View>
            <Text style={styles.statusText}>
              {isScanning ? 'Scanning for iTantra nodes...' : 'Discovery paused'}
            </Text>
            <Text style={styles.deviceIdText}>This device: {localDeviceId}</Text>
          </View>
          <TouchableOpacity
            style={[styles.scanBtn, isScanning && styles.scanBtnActive]}
            onPress={handleScanToggle}
          >
            {isScanning ? (
              <ActivityIndicator size="small" color="#00e676" />
            ) : (
              <Text style={styles.scanBtnText}>SCAN</Text>
            )}
          </TouchableOpacity>
        </View>

        {/* Status indicators */}
        <View style={styles.statusBar}>
          <Text style={[styles.statusDot, isAdvertising ? styles.dotGreen : styles.dotGray]}>●</Text>
          <Text style={styles.statusLabel}>Advertising: {isAdvertising ? 'ON' : 'OFF'}</Text>
          <Text style={[styles.statusDot, isScanning ? styles.dotGreen : styles.dotGray]}>●</Text>
          <Text style={styles.statusLabel}>Scanning: {isScanning ? 'ON' : 'OFF'}</Text>
          {connectionState !== 'IDLE' && (
            <>
              <Text style={[styles.statusDot, connectionState === 'CONNECTED' ? styles.dotGreen : styles.dotOrange]}>●</Text>
              <Text style={styles.statusLabel}>Connection: {connectionState}</Text>
            </>
          )}
        </View>

        {/* Connection diagnostics (per-peer) */}
        {connectedCount > 0 && (
          <View style={styles.connectionBox}>
            <Text style={styles.connectionTitle}>
              Connection{connectedCount > 1 ? 's' : ''} Active ({connectedCount})
            </Text>
            {connectedCount === 1 && connectedDeviceId && (
              <>
                <Text style={styles.connectionDetail}>Device: {connectedDeviceId}</Text>
                <Text style={styles.connectionDetail}>MTU: {mtu} bytes</Text>
              </>
            )}
            {connectedCount > 1 && (
              <Text style={styles.connectionDetail}>
                {Array.from(peers.values())
                  .filter((p) => p.state === 'CONNECTED')
                  .map((p) => `${p.deviceId}${p.role ? ` (${p.role})` : ''}`)
                  .join(', ')}
              </Text>
            )}
            {lastReceivedData && (
              <Text style={styles.connectionDetail}>Last received: {lastReceivedData}</Text>
            )}
          </View>
        )}

        {/* V9E Step 10: voice destination selection. The destination is a
            BITCHAT nodeId (logical mesh identity) — never a Bluetooth
            deviceId. Direct peers and multi-hop discovered nodes are shown
            distinctly so a node several hops away can be selected. */}
        <View style={styles.destBox}>
          <Text style={styles.destTitle} testID="section-destination">
            VOICE DESTINATION
          </Text>
          <Text style={styles.destHint}>
            Voice messages are addressed to this mesh node (or broadcast).
          </Text>
          {destinationRows.map((d) => {
            const selected = d.nodeId === voiceDestination;
            return (
              <TouchableOpacity
                key={d.nodeId}
                style={[styles.destRow, selected && styles.destRowSelected]}
                onPress={() => handleSelectDestination(d.nodeId)}
                testID={`dest-${d.nodeId}`}
              >
                <Text style={[styles.destNodeId, selected && styles.destNodeIdSelected]}>
                  {d.nodeId}
                </Text>
                <Text style={styles.destKind}>{d.label}</Text>
                <Text style={[styles.destCheck, selected && styles.destCheckSelected]}>
                  {selected ? '✓' : ''}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* BT disabled warning */}
        {!bluetoothEnabled && (
          <View style={styles.warningBox}>
            <Text style={styles.warningText}>Bluetooth is disabled. Enable it in system settings.</Text>
          </View>
        )}

        {error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {connectionError && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{connectionError}</Text>
          </View>
        )}

        {/* Section headers rendered inside the list header */}
        <FlatList
          data={peerRows}
          keyExtractor={(item) => item.deviceId}
          scrollEnabled={false}
          ListHeaderComponent={
            <>
              {connectedCount > 0 && (
                <Text style={styles.sectionHeader} testID="section-connected">
                  CONNECTED ({connectedCount})
                </Text>
              )}
              {availableCount > 0 && (
                <Text style={styles.sectionHeader} testID="section-available">
                  AVAILABLE
                </Text>
              )}
            </>
          }
          ListEmptyComponent={
            <View style={styles.emptyBox} testID="empty-state">
              <Text style={styles.emptyText}>
                {isScanning ? 'Scanning...' : 'Tap SCAN to discover nearby devices'}
              </Text>
            </View>
          }
          renderItem={renderPeerCard}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0c' },
  scrollContent: { padding: 15 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  statusText: { color: '#00e676', fontSize: 16, fontWeight: '600' },
  deviceIdText: { color: '#8e8e93', fontSize: 12, marginTop: 2 },
  scanBtn: {
    backgroundColor: '#1c1c1e', paddingVertical: 10, paddingHorizontal: 18,
    borderRadius: 8, borderWidth: 1, borderColor: '#2c2c2e', minWidth: 70, alignItems: 'center',
  },
  scanBtnActive: { borderColor: '#00e676' },
  scanBtnText: { color: '#fff', fontWeight: 'bold', fontSize: 14 },
  statusBar: { flexDirection: 'row', alignItems: 'center', marginBottom: 15, gap: 6 },
  statusDot: { fontSize: 10 },
  dotGreen: { color: '#00e676' },
  dotOrange: { color: '#ff9500' },
  dotGray: { color: '#48484a' },
  statusLabel: { color: '#8e8e93', fontSize: 12, marginRight: 12 },
  connectionBox: {
    backgroundColor: '#0a2e1a', padding: 12, borderRadius: 8,
    marginBottom: 12, borderWidth: 1, borderColor: '#00e676',
  },
  connectionTitle: { color: '#00e676', fontSize: 14, fontWeight: 'bold', marginBottom: 4 },
  connectionDetail: { color: '#8e8e93', fontSize: 12, marginBottom: 2 },
  warningBox: {
    backgroundColor: '#3a2a00', padding: 12, borderRadius: 8,
    marginBottom: 12, borderWidth: 1, borderColor: '#ff9500',
  },
  warningText: { color: '#ff9500', fontSize: 13, fontWeight: '600' },
  errorBox: {
    backgroundColor: '#2c0b0a', padding: 12, borderRadius: 8,
    marginBottom: 12, borderWidth: 1, borderColor: '#ff3b30',
  },
  errorText: { color: '#ff3b30', fontSize: 13, fontWeight: '600' },
  emptyBox: { paddingVertical: 40, alignItems: 'center' },
  emptyText: { color: '#8e8e93', fontSize: 15 },
  sectionHeader: {
    color: '#8e8e93', fontSize: 12, fontWeight: '700', letterSpacing: 1,
    marginBottom: 8, marginTop: 4,
  },
  deviceCard: {
    backgroundColor: '#1c1c1e', padding: 16, borderRadius: 12, marginBottom: 12,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    borderWidth: 1, borderColor: '#2c2c2e',
  },
  deviceCardConnected: { borderColor: '#00e676' },
  deviceCardPending: { borderColor: '#ff9500' },
  deviceInfo: { flex: 1 },
  deviceNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  deviceName: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  stateBadge: {
    fontSize: 10, fontWeight: '700', letterSpacing: 0.5,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, overflow: 'hidden',
  },
  stateBadgeConnected: { color: '#00e676', backgroundColor: 'rgba(0,230,118,0.12)' },
  stateBadgeConnecting: { color: '#ff9500', backgroundColor: 'rgba(255,149,0,0.12)' },
  stateBadgeIdle: { color: '#8e8e93', backgroundColor: 'rgba(142,142,147,0.12)' },
  deviceSubtitle: { color: '#8e8e93', fontSize: 13, marginTop: 2 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 },
  metaText: { color: '#00e676', fontSize: 12 },
  deviceRssi: { color: '#00e676', fontSize: 12, marginTop: 4 },
  destBox: {
    backgroundColor: '#141418', padding: 12, borderRadius: 8,
    marginBottom: 12, borderWidth: 1, borderColor: '#2c2c2e',
  },
  destTitle: {
    color: '#8e8e93', fontSize: 12, fontWeight: '700', letterSpacing: 1,
    marginBottom: 2,
  },
  destHint: { color: '#8e8e93', fontSize: 12, marginBottom: 8 },
  destRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 8, paddingHorizontal: 10, borderRadius: 6,
    backgroundColor: '#1c1c1e', marginBottom: 6, borderWidth: 1, borderColor: '#2c2c2e',
  },
  destRowSelected: { borderColor: '#00e676', backgroundColor: '#0a2e1a' },
  destNodeId: { color: '#fff', fontSize: 13, fontWeight: '600', flexShrink: 1 },
  destNodeIdSelected: { color: '#00e676' },
  destKind: { color: '#8e8e93', fontSize: 11, flex: 1 },
  destCheck: { color: 'transparent', fontSize: 14, fontWeight: 'bold', width: 16 },
  destCheckSelected: { color: '#00e676' },
  connectBtn: {
    backgroundColor: '#2c2c2e', paddingVertical: 8, paddingHorizontal: 16,
    borderRadius: 8, borderWidth: 1, borderColor: '#48484a', minWidth: 100, alignItems: 'center',
  },
  connectBtnActive: { backgroundColor: '#ff3b30', borderColor: '#ff3b30' },
  connectBtnPending: { borderColor: '#ff9500' },
  connectBtnText: { color: '#fff', fontWeight: 'bold', fontSize: 13 },
});
