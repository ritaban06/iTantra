import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function BenchmarkScreen() {
  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.headerTitle}>iTantra Performance</Text>
      
      <View style={styles.metricCard}>
        <Text style={styles.label}>STT Engine (Vosk)</Text>
        <Text style={styles.value}>Latency: 420 ms</Text>
      </View>
      
      <View style={styles.metricCard}>
        <Text style={styles.label}>TTS Engine (Piper)</Text>
        <Text style={styles.value}>RTF: 0.31</Text>
      </View>
      
      <View style={styles.metricCard}>
        <Text style={styles.label}>Network (BLE)</Text>
        <Text style={styles.value}>Payload: 84 bytes</Text>
        <Text style={styles.value}>E2E Latency: 1.12 sec</Text>
      </View>

      <View style={styles.metricCard}>
        <Text style={styles.label}>System</Text>
        <Text style={styles.value}>RAM: 410 MB</Text>
        <Text style={styles.value}>CPU: 32%</Text>
      </View>
      
      <TouchableOpacity style={styles.refreshBtn}>
        <Text style={styles.refreshText}>REFRESH METRICS</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0c', padding: 20 },
  headerTitle: { color: '#00e676', fontSize: 24, fontWeight: 'bold', marginBottom: 20 },
  metricCard: { backgroundColor: '#1c1c1e', padding: 20, borderRadius: 12, marginBottom: 15, borderWidth: 1, borderColor: '#2c2c2e' },
  label: { color: '#8e8e93', fontSize: 14, marginBottom: 10, textTransform: 'uppercase', fontWeight: 'bold' },
  value: { color: '#fff', fontSize: 18, marginBottom: 5 },
  refreshBtn: { marginTop: 20, backgroundColor: '#00e676', padding: 15, borderRadius: 8, alignItems: 'center' },
  refreshText: { color: '#000', fontWeight: 'bold' }
});
