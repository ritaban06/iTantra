import React, { useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, PermissionsAndroid, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSTT } from '../hooks/useSTT';

export default function HomeScreen({ navigation }: { navigation: any }) {
  const { transcript, partial, confidence, isListening, startListening, stopListening, loadModel, isModelLoaded, downloadModel, isDownloading, downloadProgress } = useSTT();

  useEffect(() => {
    const requestPermissions = async () => {
      if (Platform.OS === 'android') {
        try {
          await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
          // For MVP, try to load English model right away if permission is granted
          try {
            await loadModel('en');
          } catch (e) {
            // Model not found, start download
            await downloadModel('en');
          }
        } catch (err) {
          console.warn(err);
        }
      }
    };
    requestPermissions();
  }, [loadModel, downloadModel]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>iTantra</Text>
        <Text style={styles.subtitle}>
          Offline Communication Loop {isModelLoaded ? '(STT Ready)' : isDownloading ? '(Downloading Model...)' : ''}
        </Text>
      </View>
      
      <View style={styles.grid}>
        <TouchableOpacity style={styles.card} onPress={() => navigation.navigate('Chat')}>
          <Text style={styles.cardTitle}>Messages</Text>
          <Text style={styles.cardDesc}>View secure chat</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.card} onPress={() => navigation.navigate('Connect')}>
          <Text style={styles.cardTitle}>Discover</Text>
          <Text style={styles.cardDesc}>Pair via BLE / Wi-Fi</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.card} onPress={() => navigation.navigate('Language')}>
          <Text style={styles.cardTitle}>Language</Text>
          <Text style={styles.cardDesc}>English</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.card} onPress={() => navigation.navigate('Settings')}>
          <Text style={styles.cardTitle}>Settings</Text>
          <Text style={styles.cardDesc}>Profile & preferences</Text>
        </TouchableOpacity>
        
        <TouchableOpacity style={[styles.card, styles.alertCard]} onPress={() => navigation.navigate('Alert')}>
          <Text style={styles.cardTitle}>Emergency</Text>
          <Text style={styles.cardDesc}>Trigger Alert</Text>
        </TouchableOpacity>
        
        <TouchableOpacity style={styles.card} onPress={() => navigation.navigate('Benchmark')}>
          <Text style={styles.cardTitle}>Performance</Text>
          <Text style={styles.cardDesc}>Metrics & Dashboard</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.sttDisplay}>
        {isDownloading ? (
          <View>
            <Text style={styles.transcript}>Downloading language model...</Text>
            <Text style={styles.confidence}>{downloadProgress}%</Text>
          </View>
        ) : (partial || transcript) ? (
          <View>
            <Text style={styles.transcript}>{partial || transcript}</Text>
            {!!transcript && <Text style={styles.confidence}>Confidence: {(confidence * 100).toFixed(0)}%</Text>}
            {!!transcript && confidence < 0.6 && <Text style={styles.warningText}>Speech unclear. Please repeat.</Text>}
          </View>
        ) : null}
      </View>

      <View style={styles.pttContainer}>
        <TouchableOpacity 
          style={[styles.pttButton, isListening && styles.pttButtonActive]} 
          onPressIn={() => startListening('en')} 
          onPressOut={() => stopListening()}>
          <View style={styles.pttInner}>
            <Text style={styles.pttText}>{isListening ? 'LISTENING...' : 'HOLD TO SPEAK'}</Text>
          </View>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0c',
  },
  header: {
    padding: 20,
    marginTop: 20,
  },
  title: {
    fontSize: 34,
    fontWeight: '900',
    color: '#00e676',
    letterSpacing: 1,
  },
  subtitle: {
    fontSize: 16,
    color: '#8e8e93',
    marginTop: 4,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    padding: 10,
    justifyContent: 'space-between',
  },
  card: {
    width: '47%',
    backgroundColor: '#1c1c1e',
    padding: 20,
    borderRadius: 16,
    marginBottom: 15,
    borderWidth: 1,
    borderColor: '#2c2c2e',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 5,
    elevation: 5,
  },
  alertCard: {
    borderColor: '#ff3b30',
    backgroundColor: '#2c0b0a',
  },
  cardTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
  },
  cardDesc: {
    color: '#8e8e93',
    fontSize: 13,
  },
  pttContainer: {
    flex: 1,
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingBottom: 40,
  },
  pttButton: {
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: '#00e676',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#00e676',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 20,
    elevation: 10,
  },
  pttInner: {
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  pttText: {
    color: '#000',
    fontWeight: 'bold',
    fontSize: 14,
    textAlign: 'center',
  },
  pttButtonActive: {
    backgroundColor: '#ff3b30',
    shadowColor: '#ff3b30',
  },
  sttDisplay: {
    padding: 20,
    minHeight: 100,
    justifyContent: 'center',
    alignItems: 'center',
  },
  transcript: {
    color: '#fff',
    fontSize: 20,
    textAlign: 'center',
    fontStyle: 'italic',
  },
  confidence: {
    color: '#8e8e93',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 5,
  },
  warningText: {
    color: '#ffcc00',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 5,
    fontWeight: 'bold',
  }
});
