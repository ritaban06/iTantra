import React, { useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, PermissionsAndroid, Platform, Modal } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSTT } from '../hooks/useSTT';
import { usePTT } from '../hooks/usePTT';
import { useBLE } from '../hooks/useBLE';
import { useBLEVoiceMode } from '../hooks/useBLEVoiceMode';
import { useLanguage } from '../state/LanguageContext';
import { AppState } from '../state/appReducer';
import { getLanguageDisplayName } from '../semantic';

export default function HomeScreen({ navigation }: { navigation: any }) {
  const { transcript, partial, confidence, loadModel, isModelLoaded, downloadModel, cancelDownload, isDownloading, downloadProgress, error: sttError } = useSTT();
  const { connectionState, connectedDeviceId } = useBLE();
  const {
    enabled: bleVoiceEnabled,
    status: bleVoiceStatus,
    lastSentMessage,
    sendStatus,
    lastReceivedMessage,
    voiceError,
    toggleVoiceMode,
    clearError,
  } = useBLEVoiceMode();
  const { languageName, languageCode } = useLanguage();

  // Pass bleVoiceEnabled to usePTT: when ON, PTT uses direct NativeSTT (no local TTS).
  const { appState, error: pttError, pressIn, pressOut } = usePTT(bleVoiceEnabled);

  const error = sttError || pttError || voiceError;

  useEffect(() => {
    const requestPermissions = async () => {
      if (Platform.OS === 'android') {
        try {
          await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
          try {
            await loadModel(languageCode);
          } catch (e) {
            await downloadModel(languageCode);
          }
        } catch (err) {
          console.warn(err);
        }
      }
    };
    requestPermissions();
  }, [loadModel, downloadModel, languageCode]);

  const isConnected = connectionState === 'CONNECTED';
  const voiceStatusText = () => {
    switch (bleVoiceStatus) {
      case 'OFF': return 'BLE Voice Mode is off';
      case 'WAITING_FOR_SPEECH': return 'Listening for speech...';
      case 'SENDING': return 'Sending...';
      case 'SENT': return lastSentMessage ? `Sent: "${lastSentMessage.text}"` : 'Sent';
      case 'RECEIVING': return 'Receiving...';
      case 'SPEAKING': return 'Speaking received message...';
      case 'ERROR': return voiceError || 'Error occurred';
      default: return '';
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>iTantra</Text>
        <Text style={styles.subtitle}>
          Offline Communication Loop {isModelLoaded ? '(STT Ready)' : isDownloading ? '(Downloading Model...)' : ''}
        </Text>
        {error ? (
          <TouchableOpacity onPress={clearError}>
            <Text style={styles.errorText}>Error: {error}</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {/* ── BLE Voice Mode Section ──────────────────────────────── */}
      <View style={styles.bleVoiceSection}>
        <View style={styles.bleVoiceRow}>
          <View style={styles.bleVoiceLabel}>
            <Text style={styles.bleVoiceTitle}>BLE Voice Mode</Text>
            {isConnected ? (
              <Text style={styles.bleConnected}>Connected to {connectedDeviceId}</Text>
            ) : (
              <Text style={styles.bleDisconnected}>Not connected</Text>
            )}
          </View>
          <TouchableOpacity
            style={[styles.bleToggle, bleVoiceEnabled && styles.bleToggleOn]}
            onPress={toggleVoiceMode}
          >
            <Text style={[styles.bleToggleText, bleVoiceEnabled && styles.bleToggleTextOn]}>
              {bleVoiceEnabled ? 'ON' : 'OFF'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Voice mode status */}
        {bleVoiceEnabled && (
          <Text style={styles.bleStatusText}>{voiceStatusText()}</Text>
        )}

        {/* Last sent message with semantic metadata */}
        {bleVoiceEnabled && lastSentMessage && sendStatus !== 'idle' && (
          <View style={styles.sentBox}>
            <Text style={styles.sentText}>"{lastSentMessage.text}"</Text>
            <View style={styles.metadataRow}>
              <Text style={styles.metadataLabel}>Language: </Text>
              <Text style={styles.metadataValue}>{getLanguageDisplayName(lastSentMessage.language)}</Text>
              <Text style={styles.metadataSeparator}> · </Text>
              <Text style={styles.metadataLabel}>Emotion: </Text>
              <Text style={styles.metadataValue}>{lastSentMessage.emotion.charAt(0).toUpperCase() + lastSentMessage.emotion.slice(1)}</Text>
            </View>
            <Text style={[styles.sendStatus, sendStatus === 'sent' ? styles.sendStatusOk : styles.sendStatusFail]}>
              {sendStatus === 'sent' ? 'Sent ✓' : sendStatus === 'failed' ? 'Failed ✗' : 'Sending...'}
            </Text>
          </View>
        )}

        {/* Last received message with semantic metadata */}
        {lastReceivedMessage && (
          <View style={styles.receivedBox}>
            <Text style={styles.receivedLabel}>
              Received from {lastReceivedMessage.fromDevice}:
            </Text>
            <Text style={styles.receivedText}>"{lastReceivedMessage.text}"</Text>
            <View style={styles.metadataRow}>
              <Text style={styles.metadataLabel}>Language: </Text>
              <Text style={styles.metadataValue}>{lastReceivedMessage.languageDisplay}</Text>
              <Text style={styles.metadataSeparator}> · </Text>
              <Text style={styles.metadataLabel}>Emotion: </Text>
              <Text style={styles.metadataValue}>{lastReceivedMessage.emotionDisplay}</Text>
              <Text style={styles.metadataSeparator}> · </Text>
              <Text style={styles.metadataLabel}>Confidence: </Text>
              <Text style={styles.metadataValue}>{lastReceivedMessage.emotionConfidencePct}%</Text>
            </View>
            <Text style={styles.metadataLabel}>Voice: <Text style={styles.metadataValue}>{lastReceivedMessage.voiceProfileDisplay}</Text></Text>
            <Text style={styles.receivedStatus}>
              {lastReceivedMessage.status === 'speaking' ? 'Speaking...' :
               lastReceivedMessage.status === 'spoken' ? 'Spoken ✓' : 'Received'}
            </Text>
          </View>
        )}
      </View>

      {/* ── Navigation Grid ─────────────────────────────────────── */}
      <View style={styles.grid}>
        <TouchableOpacity style={styles.card} onPress={() => navigation.navigate('Chat')}>
          <Text style={styles.cardTitle}>Messages</Text>
          <Text style={styles.cardDesc}>View secure chat</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.card} onPress={() => navigation.navigate('Connect')}>
          <Text style={styles.cardTitle}>Discover</Text>
          <Text style={styles.cardDesc}>Pair via BLE</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.card} onPress={() => navigation.navigate('Language')}>
          <Text style={styles.cardTitle}>Language</Text>
          <Text style={styles.cardDesc}>{languageName}</Text>
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

        <TouchableOpacity style={styles.card} onPress={() => navigation.navigate('LoopTest')}>
          <Text style={styles.cardTitle}>Local Loop</Text>
          <Text style={styles.cardDesc}>Test Speech Loop</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.card} onPress={() => navigation.navigate('SherpaDiag')}>
          <Text style={styles.cardTitle}>Speech Diag</Text>
          <Text style={styles.cardDesc}>Experimental sherpa-onnx</Text>
        </TouchableOpacity>
      </View>

      {/* ── Download Modal ──────────────────────────────────────── */}
      <Modal visible={isDownloading} transparent={true} animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Downloading {languageName} Model</Text>
            <View style={styles.progressBarContainer}>
              <View style={[styles.progressBarFill, { width: `${downloadProgress}%` }]} />
            </View>
            <Text style={styles.modalPercent}>{downloadProgress}%</Text>
            <TouchableOpacity style={styles.cancelButton} onPress={cancelDownload}>
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ── STT Transcript Display ──────────────────────────────── */}
      <View style={styles.sttDisplay}>
        {(partial || transcript) ? (
          <View>
            <Text style={styles.transcript}>{partial || transcript}</Text>
            {!!transcript && <Text style={styles.confidence}>Confidence: {(confidence * 100).toFixed(0)}%</Text>}
            {!!transcript && confidence < 0.6 && <Text style={styles.warningText}>Speech unclear. Please repeat.</Text>}
          </View>
        ) : null}
      </View>

      {/* ── PTT Button ──────────────────────────────────────────── */}
      <View style={styles.pttContainer}>
        <TouchableOpacity
          style={[styles.pttButton, appState === AppState.LISTENING && styles.pttButtonActive]}
          onPressIn={() => pressIn(languageCode)}
          onPressOut={() => pressOut()}
          disabled={appState === AppState.PROCESSING_STT || appState === AppState.PLAYING_TTS}
        >
          <View style={styles.pttInner}>
            <Text style={styles.pttText}>
              {appState === AppState.LISTENING ? 'LISTENING...' :
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
  header: { padding: 20, marginTop: 20 },
  title: { fontSize: 34, fontWeight: '900', color: '#00e676', letterSpacing: 1 },
  subtitle: { fontSize: 16, color: '#8e8e93', marginTop: 4 },
  errorText: { color: '#ff3b30', marginTop: 10, fontSize: 14, fontWeight: 'bold' },

  // ── BLE Voice Mode ──────────────────────────────────────────────
  bleVoiceSection: {
    marginHorizontal: 10, marginBottom: 10, backgroundColor: '#1c1c1e',
    padding: 14, borderRadius: 12, borderWidth: 1, borderColor: '#2c2c2e',
  },
  bleVoiceRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  bleVoiceLabel: { flex: 1 },
  bleVoiceTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  bleConnected: { color: '#00e676', fontSize: 12, marginTop: 2 },
  bleDisconnected: { color: '#8e8e93', fontSize: 12, marginTop: 2 },
  bleToggle: {
    backgroundColor: '#2c2c2e', paddingVertical: 6, paddingHorizontal: 16,
    borderRadius: 16, borderWidth: 1, borderColor: '#48484a',
  },
  bleToggleOn: { backgroundColor: '#00e676', borderColor: '#00e676' },
  bleToggleText: { color: '#8e8e93', fontWeight: 'bold', fontSize: 13 },
  bleToggleTextOn: { color: '#000' },
  bleStatusText: { color: '#8e8e93', fontSize: 13, marginTop: 8 },
  sentBox: {
    marginTop: 8, backgroundColor: '#1c1c2e', padding: 10, borderRadius: 8,
    borderWidth: 1, borderColor: '#4a6fa5',
  },
  sentText: { color: '#fff', fontSize: 15, fontWeight: '600', fontStyle: 'italic' },
  sendStatus: { fontSize: 12, fontWeight: 'bold', marginTop: 4 },
  sendStatusOk: { color: '#00e676' },
  sendStatusFail: { color: '#ff3b30' },
  receivedBox: {
    marginTop: 8, backgroundColor: '#0a2e1a', padding: 10, borderRadius: 8,
    borderWidth: 1, borderColor: '#00e676',
  },
  receivedLabel: { color: '#8e8e93', fontSize: 12, marginBottom: 2 },
  receivedText: { color: '#00e676', fontSize: 15, fontWeight: '600' },
  receivedStatus: { color: '#00e676', fontSize: 12, fontWeight: 'bold', marginTop: 4 },
  metadataRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 4 },
  metadataLabel: { color: '#8e8e93', fontSize: 11 },
  metadataValue: { color: '#aaa', fontSize: 11, fontWeight: '600' },
  metadataSeparator: { color: '#48484a', fontSize: 11 },

  // ── Grid ────────────────────────────────────────────────────────
  grid: { flexDirection: 'row', flexWrap: 'wrap', padding: 10, justifyContent: 'space-between' },
  card: {
    width: '47%', backgroundColor: '#1c1c1e', padding: 20, borderRadius: 16,
    marginBottom: 15, borderWidth: 1, borderColor: '#2c2c2e',
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3,
    shadowRadius: 5, elevation: 5,
  },
  alertCard: { borderColor: '#ff3b30', backgroundColor: '#2c0b0a' },
  cardTitle: { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 8 },
  cardDesc: { color: '#8e8e93', fontSize: 13 },

  // ── PTT ─────────────────────────────────────────────────────────
  pttContainer: { flex: 1, justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 40 },
  pttButton: {
    width: 140, height: 140, borderRadius: 70, backgroundColor: '#00e676',
    justifyContent: 'center', alignItems: 'center',
    shadowColor: '#00e676', shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.6,
    shadowRadius: 20, elevation: 10,
  },
  pttInner: {
    width: 120, height: 120, borderRadius: 60, borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.5)', justifyContent: 'center', alignItems: 'center',
  },
  pttText: { color: '#000', fontWeight: 'bold', fontSize: 14, textAlign: 'center' },
  pttButtonActive: { backgroundColor: '#ff3b30', shadowColor: '#ff3b30' },

  // ── STT Display ─────────────────────────────────────────────────
  sttDisplay: { padding: 20, minHeight: 80, justifyContent: 'center', alignItems: 'center' },
  transcript: { color: '#fff', fontSize: 20, textAlign: 'center', fontStyle: 'italic' },
  confidence: { color: '#8e8e93', fontSize: 12, textAlign: 'center', marginTop: 5 },
  warningText: { color: '#ffcc00', fontSize: 14, textAlign: 'center', marginTop: 5, fontWeight: 'bold' },

  // ── Modal ───────────────────────────────────────────────────────
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.7)', justifyContent: 'center', alignItems: 'center' },
  modalContent: {
    width: '80%', backgroundColor: '#1c1c1e', borderRadius: 16, padding: 25,
    alignItems: 'center', borderWidth: 1, borderColor: '#2c2c2e',
  },
  modalTitle: { color: '#fff', fontSize: 18, fontWeight: 'bold', marginBottom: 20, textAlign: 'center' },
  progressBarContainer: { width: '80%', height: 8, backgroundColor: '#2c2c2e', borderRadius: 4, marginTop: 15, overflow: 'hidden' },
  progressBarFill: { height: '100%', backgroundColor: '#00e676', borderRadius: 4 },
  modalPercent: { color: '#00e676', fontSize: 16, fontWeight: 'bold', marginTop: 10 },
  cancelButton: { marginTop: 25, paddingVertical: 10, paddingHorizontal: 25, backgroundColor: 'rgba(255, 59, 48, 0.2)', borderRadius: 8, borderWidth: 1, borderColor: '#ff3b30' },
  cancelButtonText: { color: '#ff3b30', fontSize: 16, fontWeight: 'bold' },
});
