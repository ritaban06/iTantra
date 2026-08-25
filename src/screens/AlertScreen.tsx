import React, { useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTTS } from '../hooks/useTTS';

export default function AlertScreen({ navigation }: { navigation: any }) {
  const { speak, stop } = useTTS();

  useEffect(() => {
    speak("Flood water entering shelter three. Evacuate immediately.", "en", true);
    return () => {
      stop();
    };
  }, []);

  const handleAck = () => {
    stop();
    navigation.goBack();
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <View style={styles.warningCircle}>
          <Text style={styles.warningIcon}>!</Text>
        </View>
        <Text style={styles.title}>EMERGENCY ALERT</Text>
        <Text style={styles.message}>
          "Flood water entering shelter three. Evacuate immediately."
        </Text>
        <Text style={styles.sender}>From: ITN-C903 • 2 mins ago</Text>
      </View>
      
      <View style={styles.actions}>
        <TouchableOpacity style={styles.ackBtn} onPress={handleAck}>
          <Text style={styles.ackText}>ACKNOWLEDGE</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#7a0000', padding: 20 },
  content: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  warningCircle: { width: 100, height: 100, borderRadius: 50, backgroundColor: '#ff3b30', justifyContent: 'center', alignItems: 'center', marginBottom: 30, borderWidth: 4, borderColor: '#fff' },
  warningIcon: { fontSize: 60, color: '#fff', fontWeight: 'bold' },
  title: { fontSize: 32, fontWeight: '900', color: '#fff', marginBottom: 20, textAlign: 'center', letterSpacing: 2 },
  message: { fontSize: 24, color: '#fff', textAlign: 'center', lineHeight: 34, fontStyle: 'italic', paddingHorizontal: 10 },
  sender: { marginTop: 30, color: 'rgba(255,255,255,0.7)', fontSize: 16 },
  actions: { paddingBottom: 30 },
  ackBtn: { backgroundColor: '#fff', padding: 20, borderRadius: 12, alignItems: 'center' },
  ackText: { color: '#7a0000', fontSize: 18, fontWeight: 'bold', letterSpacing: 1 }
});
