import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function BenchmarkScreen() {
  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.headerTitle}>iTantra Performance</Text>
      
      <View style={styles.metricCard}>
        <Text style={styles.label}>STT Engine</Text>
        <Text style={styles.value}>Speech → STT final: not yet measured on device</Text>
      </View>

      <View style={styles.metricCard}>
        <Text style={styles.label}>TTS Engine (device TTS)</Text>
        <Text style={styles.value}>RTF: not yet measured on device</Text>
      </View>

      <View style={styles.metricCard}>
        <Text style={styles.label}>Network (BLE)</Text>
        <Text style={styles.value}>Bytes per message: derived from protocol (V6A 18B + V6B 10B + BITCHAT 28B + text)</Text>
        <Text style={styles.value}>E2E Latency: not yet measured on device</Text>
      </View>

      <View style={styles.metricCard}>
        <Text style={styles.label}>System</Text>
        <Text style={styles.value}>RAM / CPU / footprint: not yet measured on device</Text>
      </View>

      <Text style={styles.note}>
        These metrics require physical-device measurement (see the physical validation matrix).
        No numbers are shown until they are actually measured.
      </Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0c', padding: 20 },
  headerTitle: { color: '#00e676', fontSize: 24, fontWeight: 'bold', marginBottom: 20 },
  metricCard: { backgroundColor: '#1c1c1e', padding: 20, borderRadius: 12, marginBottom: 15, borderWidth: 1, borderColor: '#2c2c2e' },
  label: { color: '#8e8e93', fontSize: 14, marginBottom: 10, textTransform: 'uppercase', fontWeight: 'bold' },
  value: { color: '#fff', fontSize: 18, marginBottom: 5 },
  note: { color: '#8e8e93', fontSize: 13, marginTop: 10, lineHeight: 18 }
});
