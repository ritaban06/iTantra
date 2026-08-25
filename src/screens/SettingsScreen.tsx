import React from 'react';
import { View, Text, StyleSheet, SafeAreaView, TextInput, TouchableOpacity } from 'react-native';

export default function SettingsScreen() {
  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.sectionHeader}>Local Identity</Text>
      <View style={styles.card}>
        <Text style={styles.label}>Device ID (Auto-generated)</Text>
        <Text style={styles.deviceId}>ITN-A7F3-92KD</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>Display Name (Optional)</Text>
        <TextInput 
          style={styles.input} 
          placeholder="e.g. Rahul" 
          placeholderTextColor="#8e8e93" 
          defaultValue="Rahul"
        />
      </View>
      
      <Text style={styles.sectionHeader}>Pairing</Text>
      <TouchableOpacity style={styles.actionBtn}>
        <Text style={styles.actionText}>Show My QR Code</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.actionBtn}>
        <Text style={styles.actionText}>Scan Partner QR Code</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0c', padding: 20 },
  sectionHeader: { color: '#8e8e93', fontSize: 14, fontWeight: 'bold', textTransform: 'uppercase', marginTop: 20, marginBottom: 10 },
  card: { backgroundColor: '#1c1c1e', padding: 20, borderRadius: 12, marginBottom: 15, borderWidth: 1, borderColor: '#2c2c2e' },
  label: { color: '#8e8e93', fontSize: 14, marginBottom: 10 },
  deviceId: { color: '#00e676', fontSize: 20, fontWeight: 'bold', letterSpacing: 2 },
  input: { color: '#fff', fontSize: 18, borderBottomWidth: 1, borderBottomColor: '#2c2c2e', paddingVertical: 5 },
  actionBtn: { backgroundColor: '#1c1c1e', padding: 18, borderRadius: 12, marginBottom: 15, alignItems: 'center', borderWidth: 1, borderColor: '#2c2c2e' },
  actionText: { color: '#00e676', fontSize: 16, fontWeight: 'bold' }
});
