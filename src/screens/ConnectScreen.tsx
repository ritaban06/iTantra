import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, FlatList } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const MOCK_DEVICES = [
  { id: 'ITN-B291', signal: -45, status: 'Connected' },
  { id: 'ITN-C903', signal: -70, status: 'Available' },
  { id: 'ITN-D771', signal: -88, status: 'Available' },
];

export default function ConnectScreen() {
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.statusText}>Scanning for iTantra nodes...</Text>
        <TouchableOpacity style={styles.scanBtn}>
          <Text style={styles.scanBtnText}>RESCAN</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={MOCK_DEVICES}
        keyExtractor={item => item.id}
        renderItem={({ item }: { item: any }) => (
          <TouchableOpacity style={styles.deviceCard}>
            <View>
              <Text style={styles.deviceName}>{item.id}</Text>
              <Text style={[styles.deviceStatus, item.status === 'Connected' && styles.connected]}>
                {item.status}
              </Text>
            </View>
            <View style={styles.signalBox}>
              <Text style={styles.signal}>{item.signal} dBm</Text>
            </View>
          </TouchableOpacity>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0c', padding: 15 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  statusText: { color: '#00e676', fontSize: 16 },
  scanBtn: { backgroundColor: '#1c1c1e', padding: 10, borderRadius: 8, borderWidth: 1, borderColor: '#2c2c2e' },
  scanBtnText: { color: '#fff', fontWeight: 'bold' },
  deviceCard: { backgroundColor: '#1c1c1e', padding: 20, borderRadius: 12, marginBottom: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderWidth: 1, borderColor: '#2c2c2e' },
  deviceName: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  deviceStatus: { color: '#8e8e93', marginTop: 4 },
  connected: { color: '#00e676' },
  signalBox: { backgroundColor: '#2c2c2e', padding: 8, borderRadius: 6 },
  signal: { color: '#00e676', fontWeight: 'bold' }
});
