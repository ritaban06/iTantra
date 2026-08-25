import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  TextInput,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useBLE, DiscoveredDevice, ConnectionState } from '../hooks/useBLE';

export default function ConnectScreen() {
  const {
    bluetoothEnabled,
    isScanning,
    isAdvertising,
    discoveredDevices,
    error,
    localDeviceId,
    connectionState,
    connectedDeviceId,
    mtu,
    lastReceivedData,
    receivedHistory,
    connectionError,
    startScanning,
    stopScanning,
    startAdvertising,
    stopAdvertising,
    refreshBluetoothState,
    connect,
    disconnect,
    send,
  } = useBLE();

  const [helloText, setHelloText] = useState('HELLO');

  // Refresh BT state on mount.
  useEffect(() => {
    refreshBluetoothState();
  }, []);

  // Auto-start advertising so this device is visible to others.
  useEffect(() => {
    if (bluetoothEnabled && !isAdvertising) {
      startAdvertising();
    }
  }, [bluetoothEnabled]);

  const deviceArray: DiscoveredDevice[] = Array.from(discoveredDevices.values()).sort(
    (a, b) => b.rssi - a.rssi,
  );

  const handleScanToggle = () => {
    if (isScanning) {
      stopScanning();
    } else {
      startScanning();
    }
  };

  const handleConnect = (deviceId: string) => {
    if (connectionState === 'CONNECTED' && connectedDeviceId === deviceId) {
      disconnect();
    } else if (connectionState === 'IDLE') {
      connect(deviceId);
    }
  };

  const handleSend = () => {
    if (helloText.trim()) {
      send(helloText.trim());
    }
  };

  const getConnectionLabel = (deviceId: string): string => {
    if (connectionState === 'CONNECTING' && connectedDeviceId === deviceId) return 'CONNECTING...';
    if (connectionState === 'CONNECTED' && connectedDeviceId === deviceId) return 'DISCONNECT';
    return 'CONNECT';
  };

  const isConnectedTo = (deviceId: string): boolean =>
    connectionState === 'CONNECTED' && connectedDeviceId === deviceId;

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

        {/* BT disabled warning */}
        {!bluetoothEnabled && (
          <View style={styles.warningBox}>
            <Text style={styles.warningText}>Bluetooth is disabled. Enable it in system settings.</Text>
          </View>
        )}

        {/* Error display */}
        {error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* Connection error */}
        {connectionError && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{connectionError}</Text>
          </View>
        )}

        {/* Device list */}
        <FlatList
          data={deviceArray}
          keyExtractor={(item) => item.deviceId}
          scrollEnabled={false}
          ListEmptyComponent={
            <View style={styles.emptyBox}>
              <Text style={styles.emptyText}>
                {isScanning ? 'Scanning...' : 'Tap SCAN to discover nearby devices'}
              </Text>
            </View>
          }
          renderItem={({ item }: { item: DiscoveredDevice }) => (
            <View style={styles.deviceCard}>
              <View style={styles.deviceInfo}>
                <Text style={styles.deviceName}>{item.deviceId}</Text>
                {item.name ? <Text style={styles.deviceSubtitle}>{item.name}</Text> : null}
                <Text style={styles.deviceRssi}>{item.rssi} dBm</Text>
              </View>
              <TouchableOpacity
                style={[
                  styles.connectBtn,
                  isConnectedTo(item.deviceId) && styles.connectBtnActive,
                  connectionState === 'CONNECTING' && styles.connectBtnPending,
                ]}
                onPress={() => handleConnect(item.deviceId)}
                disabled={connectionState === 'CONNECTING'}
              >
                {connectionState === 'CONNECTING' && connectedDeviceId === item.deviceId ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.connectBtnText}>
                    {getConnectionLabel(item.deviceId)}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          )}
        />

        {/* ── Temporary HELLO test UI ──────────────────────────────── */}
        {connectionState === 'CONNECTED' && (
          <View style={styles.testSection}>
            <Text style={styles.testSectionTitle}>HELLO Test (Development Only)</Text>
            <Text style={styles.testConnected}>
              Connected to {connectedDeviceId} • MTU: {mtu}
            </Text>

            <View style={styles.sendRow}>
              <TextInput
                style={styles.sendInput}
                value={helloText}
                onChangeText={setHelloText}
                placeholder="Type message..."
                placeholderTextColor="#48484a"
              />
              <TouchableOpacity style={styles.sendBtn} onPress={handleSend}>
                <Text style={styles.sendBtnText}>SEND</Text>
              </TouchableOpacity>
            </View>

            {lastReceivedData && (
              <View style={styles.receivedBox}>
                <Text style={styles.receivedLabel}>Last received:</Text>
                <Text style={styles.receivedText}>{lastReceivedData}</Text>
              </View>
            )}

            {receivedHistory.length > 0 && (
              <View style={styles.historyBox}>
                <Text style={styles.receivedLabel}>History:</Text>
                {receivedHistory.map((item, idx) => (
                  <Text key={idx} style={styles.historyItem}>
                    {item.data}
                  </Text>
                ))}
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0c' },
  scrollContent: { padding: 15 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  statusText: { color: '#00e676', fontSize: 16, fontWeight: '600' },
  deviceIdText: { color: '#8e8e93', fontSize: 12, marginTop: 2 },
  scanBtn: {
    backgroundColor: '#1c1c1e',
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#2c2c2e',
    minWidth: 70,
    alignItems: 'center',
  },
  scanBtnActive: { borderColor: '#00e676' },
  scanBtnText: { color: '#fff', fontWeight: 'bold', fontSize: 14 },
  statusBar: { flexDirection: 'row', alignItems: 'center', marginBottom: 15, gap: 6 },
  statusDot: { fontSize: 10 },
  dotGreen: { color: '#00e676' },
  dotOrange: { color: '#ff9500' },
  dotGray: { color: '#48484a' },
  statusLabel: { color: '#8e8e93', fontSize: 12, marginRight: 12 },
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
  deviceCard: {
    backgroundColor: '#1c1c1e', padding: 16, borderRadius: 12, marginBottom: 12,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    borderWidth: 1, borderColor: '#2c2c2e',
  },
  deviceInfo: { flex: 1 },
  deviceName: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  deviceSubtitle: { color: '#8e8e93', fontSize: 13, marginTop: 2 },
  deviceRssi: { color: '#00e676', fontSize: 12, marginTop: 4 },
  connectBtn: {
    backgroundColor: '#2c2c2e', paddingVertical: 8, paddingHorizontal: 16,
    borderRadius: 8, borderWidth: 1, borderColor: '#48484a', minWidth: 100, alignItems: 'center',
  },
  connectBtnActive: { backgroundColor: '#ff3b30', borderColor: '#ff3b30' },
  connectBtnPending: { borderColor: '#ff9500' },
  connectBtnText: { color: '#fff', fontWeight: 'bold', fontSize: 13 },

  // ── Test section ────────────────────────────────────────────────────
  testSection: {
    marginTop: 20, backgroundColor: '#1c1c1e', padding: 16, borderRadius: 12,
    borderWidth: 1, borderColor: '#ff9500',
  },
  testSectionTitle: { color: '#ff9500', fontSize: 14, fontWeight: 'bold', marginBottom: 8 },
  testConnected: { color: '#8e8e93', fontSize: 12, marginBottom: 12 },
  sendRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  sendInput: {
    flex: 1, backgroundColor: '#2c2c2e', color: '#fff', padding: 10,
    borderRadius: 8, borderWidth: 1, borderColor: '#48484a', fontSize: 14,
  },
  sendBtn: {
    backgroundColor: '#00e676', paddingVertical: 10, paddingHorizontal: 20,
    borderRadius: 8, justifyContent: 'center',
  },
  sendBtnText: { color: '#000', fontWeight: 'bold', fontSize: 14 },
  receivedBox: { marginBottom: 10 },
  receivedLabel: { color: '#8e8e93', fontSize: 12, marginBottom: 4 },
  receivedText: { color: '#00e676', fontSize: 16, fontWeight: '600' },
  historyBox: { marginTop: 8 },
  historyItem: { color: '#8e8e93', fontSize: 13, marginBottom: 4 },
});
