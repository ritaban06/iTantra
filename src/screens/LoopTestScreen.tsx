import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, SafeAreaView, ScrollView } from 'react-native';
import { usePTT } from '../hooks/usePTT';
import { useSTT } from '../hooks/useSTT';
import { useLanguage } from '../state/LanguageContext';
import { AppState } from '../state/appReducer';
import { NativeEventEmitter, NativeModules } from 'react-native';
import { ModelScheduler } from '../services/ModelScheduler';

const { NativeSTT, NativeTTS } = NativeModules;

export default function LoopTestScreen() {
  const { appState, error: pttError, pressIn, pressOut } = usePTT();
  const { transcript, partial, confidence, error: sttError } = useSTT();
  const { languageCode, languageName } = useLanguage();

  const [latencies, setLatencies] = useState<{
    pttRelease: number | null;
    sttResult: number | null;
    ttsStart: number | null;
  }>({ pttRelease: null, sttResult: null, ttsStart: null });
  
  const [modelStatus, setModelStatus] = useState('Loading...');

  useEffect(() => {
    ModelScheduler.loadModelsForLanguage(languageCode)
      .then(() => setModelStatus('Ready'))
      .catch(e => setModelStatus(`Error: ${e.message}`));

    return () => {
      ModelScheduler.unloadModels();
      import('../services/LocalLoopService').then(module => module.LocalLoopService.teardown());
    };
  }, [languageCode]);

  useEffect(() => {
    const sttEmitter = new NativeEventEmitter(NativeSTT);
    const ttsEmitter = new NativeEventEmitter(NativeTTS);

    const subs = [
      sttEmitter.addListener('STT_RESULT', () => {
        setLatencies(prev => ({ ...prev, sttResult: Date.now() }));
      }),
      ttsEmitter.addListener('TTS_STARTED', () => {
        setLatencies(prev => ({ ...prev, ttsStart: Date.now() }));
      })
    ];

    return () => subs.forEach(s => s.remove());
  }, []);

  const handlePressOut = () => {
    setLatencies({ pttRelease: Date.now(), sttResult: null, ttsStart: null });
    pressOut();
  };

  const getLatencyText = () => {
    if (!latencies.pttRelease) return 'N/A';
    const sttLat = latencies.sttResult ? latencies.sttResult - latencies.pttRelease : '...';
    const ttsLat = (latencies.sttResult && latencies.ttsStart) ? latencies.ttsStart - latencies.sttResult : '...';
    const total = (latencies.ttsStart) ? latencies.ttsStart - latencies.pttRelease : '...';

    return `STT: ${sttLat} ms | TTS: ${ttsLat} ms | Total: ${total} ms`;
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.header}>
          <Text style={styles.title}>Local Loop Test</Text>
          <Text style={styles.subtitle}>Native Coordination Mode</Text>
        </View>

        <View style={styles.infoBox}>
          <Text style={styles.infoLabel}>State: <Text style={styles.infoValue}>{appState}</Text></Text>
          <Text style={styles.infoLabel}>Language: <Text style={styles.infoValue}>{languageName}</Text></Text>
          <Text style={styles.infoLabel}>Model: <Text style={styles.infoValue}>{modelStatus}</Text></Text>
          {(pttError || sttError) ? <Text style={styles.errorText}>{pttError || sttError}</Text> : null}
        </View>

        <View style={styles.transcriptBox}>
          <Text style={styles.label}>Live Transcript:</Text>
          <Text style={styles.partial}>{partial}</Text>
          
          <Text style={styles.label}>Final Transcript:</Text>
          <Text style={styles.final}>{transcript}</Text>
          <Text style={styles.confidence}>Confidence: {confidence > 0 ? (confidence * 100).toFixed(0) + '%' : '-'}</Text>
        </View>

        <View style={styles.metricsBox}>
          <Text style={styles.label}>Latencies (Release → Result → TTS):</Text>
          <Text style={styles.metrics}>{getLatencyText()}</Text>
        </View>
      </ScrollView>

      <View style={styles.pttContainer}>
        <TouchableOpacity 
          style={[
            styles.pttButton, 
            appState === AppState.LISTENING && styles.pttListening,
            (appState === AppState.PROCESSING_STT || appState === AppState.PLAYING_TTS) && styles.pttBusy
          ]}
          onPressIn={() => pressIn(languageCode)}
          onPressOut={handlePressOut}
          disabled={appState === AppState.PROCESSING_STT || appState === AppState.PLAYING_TTS || modelStatus !== 'Ready'}
        >
          <View style={styles.pttInner}>
            <Text style={styles.pttText}>
              {appState === AppState.LISTENING ? 'LISTENING' : 
               appState === AppState.PROCESSING_STT ? 'PROCESSING' :
               appState === AppState.PLAYING_TTS ? 'PLAYING' : 'HOLD TO SPEAK'}
            </Text>
          </View>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0c' },
  scroll: { padding: 20 },
  header: { marginBottom: 20 },
  title: { fontSize: 28, fontWeight: '900', color: '#00e676' },
  subtitle: { fontSize: 14, color: '#8e8e93' },
  infoBox: { backgroundColor: '#1c1c1e', padding: 15, borderRadius: 12, marginBottom: 15 },
  infoLabel: { color: '#8e8e93', fontSize: 14, marginBottom: 4 },
  infoValue: { color: '#fff', fontWeight: 'bold' },
  errorText: { color: '#ff3b30', marginTop: 10, fontWeight: 'bold' },
  transcriptBox: { backgroundColor: '#1c1c1e', padding: 15, borderRadius: 12, marginBottom: 15 },
  label: { color: '#8e8e93', fontSize: 12, marginBottom: 5, marginTop: 10 },
  partial: { color: '#aaa', fontSize: 16, fontStyle: 'italic' },
  final: { color: '#fff', fontSize: 18, fontWeight: '600' },
  confidence: { color: '#00e676', fontSize: 12, marginTop: 5 },
  metricsBox: { backgroundColor: '#1c1c1e', padding: 15, borderRadius: 12, marginBottom: 15 },
  metrics: { color: '#00e676', fontSize: 14, fontWeight: 'bold', marginTop: 5 },
  pttContainer: { alignItems: 'center', paddingBottom: 40, paddingTop: 10 },
  pttButton: {
    width: 140, height: 140, borderRadius: 70,
    backgroundColor: '#00e676',
    justifyContent: 'center', alignItems: 'center',
  },
  pttListening: { backgroundColor: '#ff3b30' },
  pttBusy: { backgroundColor: '#ff9500', opacity: 0.8 },
  pttInner: {
    width: 120, height: 120, borderRadius: 60,
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.5)',
    justifyContent: 'center', alignItems: 'center',
  },
  pttText: { color: '#000', fontWeight: 'bold', fontSize: 14, textAlign: 'center' }
});
