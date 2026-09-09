import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function DiagnosticsScreen({ navigation }: { navigation: any }) {
  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Text style={styles.screenTitle}>Diagnostics & Developer</Text>

        <View style={styles.card}>
          <Text style={styles.sectionHeader}>Developer Tools</Text>
          
          <TouchableOpacity style={styles.actionBtn} onPress={() => navigation.navigate('Benchmark')}>
            <Text style={styles.actionTitle}>Performance Dashboard</Text>
            <Text style={styles.actionDesc}>Metrics & hardware benchmarks</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.actionBtn} onPress={() => navigation.navigate('LoopTest')}>
            <Text style={styles.actionTitle}>Local Loop</Text>
            <Text style={styles.actionDesc}>Test speech processing pipeline</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.actionBtn} onPress={() => navigation.navigate('SherpaDiag')}>
            <Text style={styles.actionTitle}>Speech Diagnostics</Text>
            <Text style={styles.actionDesc}>Experimental sherpa-onnx features</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionHeader}>System Status</Text>

          <View style={styles.statusRow}>
            <Text style={styles.statusLabel}>BLE Connection</Text>
            <Text style={[styles.statusValue, { color: '#00e676' }]}>Connected</Text>
          </View>
          <View style={styles.statusRow}>
            <Text style={styles.statusLabel}>BLE MTU</Text>
            <Text style={styles.statusValue}>512</Text>
          </View>
          <View style={styles.statusRow}>
            <Text style={styles.statusLabel}>BLE RSSI</Text>
            <Text style={styles.statusValue}>-58 dBm</Text>
          </View>

          <View style={styles.divider} />

          <View style={styles.statusRow}>
            <Text style={styles.statusLabel}>Speech STT</Text>
            <Text style={[styles.statusValue, { color: '#00e676' }]}>✓ Ready</Text>
          </View>
          <View style={styles.statusRow}>
            <Text style={styles.statusLabel}>Speech TTS</Text>
            <Text style={[styles.statusValue, { color: '#00e676' }]}>✓ Ready</Text>
          </View>

          <View style={styles.divider} />

          <View style={styles.statusRow}>
            <Text style={styles.statusLabel}>Last Packet Type</Text>
            <Text style={styles.statusValue}>TEXT</Text>
          </View>
          <View style={styles.statusRow}>
            <Text style={styles.statusLabel}>Sequence</Text>
            <Text style={styles.statusValue}>142</Text>
          </View>
          <View style={styles.statusRow}>
            <Text style={styles.statusLabel}>Payload</Text>
            <Text style={styles.statusValue}>38 B</Text>
          </View>
          <View style={styles.statusRow}>
            <Text style={styles.statusLabel}>Encryption</Text>
            <Text style={[styles.statusValue, { color: '#00e676' }]}>✓ Active</Text>
          </View>
        </View>

      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0c' },
  scrollContent: { padding: 20, paddingBottom: 40 },
  screenTitle: { color: '#fff', fontSize: 28, fontWeight: '800', marginBottom: 20 },
  card: { backgroundColor: '#1c1c1e', padding: 20, borderRadius: 16, marginBottom: 20, borderWidth: 1, borderColor: '#2c2c2e' },
  sectionHeader: { color: '#8e8e93', fontSize: 14, fontWeight: '700', textTransform: 'uppercase', marginBottom: 15, letterSpacing: 1 },
  actionBtn: { backgroundColor: '#2c2c2e', padding: 16, borderRadius: 12, marginBottom: 12 },
  actionTitle: { color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 4 },
  actionDesc: { color: '#8e8e93', fontSize: 13 },
  statusRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8 },
  statusLabel: { color: '#aaa', fontSize: 15 },
  statusValue: { color: '#fff', fontSize: 15, fontWeight: '600' },
  divider: { height: 1, backgroundColor: '#2c2c2e', marginVertical: 12 },
});
