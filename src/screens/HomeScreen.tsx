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
  const { languageName, languageCode, partnerLanguageName } = useLanguage();

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
  const connectionDot = isConnected ? '🟢' : (connectionState === 'CONNECTING' ? '🟡' : '🔴');
  const connectionStatusText = isConnected ? `CONNECTED TO ${connectedDeviceId?.toUpperCase()}` : 'DISCONNECTED';

  const voiceStatusText = () => {
    switch (bleVoiceStatus) {
      case 'OFF': return 'iTantra Link is off';
      case 'WAITING_FOR_SPEECH': return 'Listening for speech...';
      case 'SENDING': return 'Sending...';
      case 'SENT': return lastSentMessage ? `Sent: "${lastSentMessage.text}"` : 'Sent';
      case 'RECEIVING': return 'Receiving...';
      case 'SPEAKING': return 'Speaking received message...';
      case 'ERROR': return voiceError || 'Error occurred';
      default: return '';
    }
  };

  const pttStateConfig = () => {
    switch (appState) {
      case AppState.LISTENING: return { bg: '#ff3b30', text: 'LISTENING...\nRelease to send', icon: '🔴' };
      case AppState.PROCESSING_STT: return { bg: '#ffcc00', text: 'PROCESSING...', icon: '🟡' };
      case AppState.PLAYING_TTS: return { bg: '#5856d6', text: 'PLAYING...', icon: '🟣' };
      case AppState.IDLE:
      default:
        return { bg: '#00e676', text: 'HOLD TO\nSPEAK', icon: '🎙' };
    }
  };

  const { bg: pttBg, text: pttText, icon: pttIcon } = pttStateConfig();

  return (
    <SafeAreaView style={styles.container}>
      {/* ── Top Header ────────────────────────────────────────────── */}
      <View style={styles.header}>
        <View style={styles.headerTitleRow}>
          <Text style={styles.title}>iTantra</Text>
          <View style={styles.headerActions}>
            <TouchableOpacity style={styles.iconBtn} onPress={() => navigation.navigate('Alert')}>
              <Text style={styles.alertIcon}>🚨</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.iconBtn} onPress={() => navigation.navigate('Settings')}>
              <Text style={styles.settingsIcon}>⚙️</Text>
            </TouchableOpacity>
          </View>
        </View>
        {error ? (
          <TouchableOpacity onPress={clearError}>
            <Text style={styles.errorText}>Error: {error}</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {/* ── Connection Status Box ─────────────────────────────────── */}
      <View style={styles.connectionBox}>
        <View style={styles.connectionHeader}>
          <Text style={styles.connectionDot}>{connectionDot} {isConnected ? 'READY' : 'NOT READY'}</Text>
          <TouchableOpacity
            style={[styles.linkToggle, bleVoiceEnabled && styles.linkToggleOn]}
            onPress={toggleVoiceMode}
          >
            <Text style={[styles.linkToggleText, bleVoiceEnabled && styles.linkToggleTextOn]}>
              iTantra Link: {bleVoiceEnabled ? 'ON' : 'OFF'}
            </Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.connectionSubtext}>{connectionStatusText}</Text>
        {bleVoiceEnabled && (
          <Text style={styles.bleStatusText}>{voiceStatusText()}</Text>
        )}
      </View>

      {/* ── Language Pair ─────────────────────────────────────────── */}
      <TouchableOpacity style={styles.languageBox} onPress={() => navigation.navigate('Language')}>
        <Text style={styles.languageText}>
          {partnerLanguageName}  <Text style={styles.languageArrows}>⇄</Text>  {languageName}
        </Text>
      </TouchableOpacity>

      {/* ── PTT Button ────────────────────────────────────────────── */}
      <View style={styles.pttContainer}>
        <TouchableOpacity
          style={[styles.pttButton, { backgroundColor: pttBg, shadowColor: pttBg }]}
          onPressIn={() => pressIn(languageCode)}
          onPressOut={() => pressOut()}
          disabled={appState === AppState.PROCESSING_STT || appState === AppState.PLAYING_TTS}
        >
          <View style={styles.pttInner}>
            <Text style={styles.pttIcon}>{pttIcon}</Text>
            <Text style={styles.pttText}>{pttText}</Text>
          </View>
        </TouchableOpacity>
        
        {/* STT Partial/Transcript Overlay */}
        <View style={styles.sttDisplay}>
          {(partial || transcript) ? (
            <View>
              <Text style={styles.transcript}>{partial || transcript}</Text>
              {!!transcript && <Text style={styles.confidence}>Confidence: {(confidence * 100).toFixed(0)}%</Text>}
              {!!transcript && confidence < 0.6 && <Text style={styles.warningText}>Speech unclear. Please repeat.</Text>}
            </View>
          ) : null}
        </View>
      </View>

      {/* ── Last Message ──────────────────────────────────────────── */}
      <View style={styles.lastMessageContainer}>
        {lastReceivedMessage ? (
          <View style={styles.messageRow}>
            <Text style={styles.messageLabel}>Received:</Text>
            <Text style={styles.messageContent} numberOfLines={1}>"{lastReceivedMessage.text}"</Text>
          </View>
        ) : lastSentMessage ? (
          <View style={styles.messageRow}>
            <Text style={styles.messageLabel}>Sent:</Text>
            <Text style={styles.messageContent} numberOfLines={1}>"{lastSentMessage.text}"</Text>
          </View>
        ) : (
          <Text style={styles.emptyMessageText}>No recent messages</Text>
        )}
      </View>

      {/* ── Bottom Navigation ─────────────────────────────────────── */}
      <View style={styles.bottomNav}>
        <TouchableOpacity style={styles.bottomNavBtn} onPress={() => navigation.navigate('Chat')}>
          <Text style={styles.bottomNavIcon}>💬</Text>
          <Text style={styles.bottomNavText}>Messages</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.bottomNavBtn} onPress={() => navigation.navigate('Connect')}>
          <Text style={styles.bottomNavIcon}>📡</Text>
          <Text style={styles.bottomNavText}>Devices</Text>
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0c' },
  header: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 10 },
  headerTitleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 32, fontWeight: '900', color: '#00e676', letterSpacing: 1 },
  headerActions: { flexDirection: 'row' },
  iconBtn: { marginLeft: 15, padding: 5 },
  alertIcon: { fontSize: 24 },
  settingsIcon: { fontSize: 24 },
  errorText: { color: '#ff3b30', marginTop: 10, fontSize: 14, fontWeight: 'bold' },

  // Connection Box
  connectionBox: { marginHorizontal: 20, marginTop: 10, padding: 15, backgroundColor: '#1c1c1e', borderRadius: 12, borderWidth: 1, borderColor: '#2c2c2e' },
  connectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  connectionDot: { color: '#fff', fontSize: 16, fontWeight: '700', letterSpacing: 1 },
  connectionSubtext: { color: '#8e8e93', fontSize: 13, marginTop: 10, textTransform: 'uppercase', letterSpacing: 1 },
  linkToggle: { backgroundColor: '#2c2c2e', paddingVertical: 6, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1, borderColor: '#48484a' },
  linkToggleOn: { backgroundColor: '#00e676', borderColor: '#00e676' },
  linkToggleText: { color: '#8e8e93', fontWeight: 'bold', fontSize: 12 },
  linkToggleTextOn: { color: '#000' },
  bleStatusText: { color: '#aaa', fontSize: 13, marginTop: 8, fontStyle: 'italic' },

  // Language Pair
  languageBox: { alignItems: 'center', marginTop: 30, paddingVertical: 10 },
  languageText: { color: '#fff', fontSize: 22, fontWeight: '600' },
  languageArrows: { color: '#8e8e93', fontSize: 22, fontWeight: '400', marginHorizontal: 10 },

  // PTT
  pttContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  pttButton: {
    width: 220, height: 220, borderRadius: 110,
    justifyContent: 'center', alignItems: 'center',
    shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.5, shadowRadius: 30, elevation: 15,
  },
  pttInner: {
    width: 190, height: 190, borderRadius: 95, borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.3)', justifyContent: 'center', alignItems: 'center',
  },
  pttIcon: { fontSize: 40, marginBottom: 10 },
  pttText: { color: '#000', fontWeight: 'bold', fontSize: 16, textAlign: 'center', letterSpacing: 1 },
  
  sttDisplay: { position: 'absolute', bottom: -50, minHeight: 60, width: '90%', justifyContent: 'center', alignItems: 'center' },
  transcript: { color: '#fff', fontSize: 18, textAlign: 'center', fontStyle: 'italic', fontWeight: '600' },
  confidence: { color: '#8e8e93', fontSize: 12, textAlign: 'center', marginTop: 4 },
  warningText: { color: '#ffcc00', fontSize: 13, textAlign: 'center', marginTop: 4, fontWeight: 'bold' },

  // Last Message
  lastMessageContainer: { paddingHorizontal: 20, paddingBottom: 20 },
  messageRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1c1c1e', padding: 15, borderRadius: 12, borderWidth: 1, borderColor: '#2c2c2e' },
  messageLabel: { color: '#8e8e93', fontSize: 13, fontWeight: '700', textTransform: 'uppercase', marginRight: 10 },
  messageContent: { color: '#00e676', fontSize: 16, fontWeight: '600', flex: 1 },
  emptyMessageText: { color: '#48484a', fontSize: 14, fontStyle: 'italic', textAlign: 'center', padding: 15 },

  // Bottom Nav
  bottomNav: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#2c2c2e', backgroundColor: '#1c1c1e', paddingBottom: Platform.OS === 'ios' ? 20 : 0 },
  bottomNavBtn: { flex: 1, alignItems: 'center', paddingVertical: 15 },
  bottomNavIcon: { fontSize: 24, marginBottom: 4 },
  bottomNavText: { color: '#fff', fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 1 },

  // Modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.7)', justifyContent: 'center', alignItems: 'center' },
  modalContent: { width: '80%', backgroundColor: '#1c1c1e', borderRadius: 16, padding: 25, alignItems: 'center', borderWidth: 1, borderColor: '#2c2c2e' },
  modalTitle: { color: '#fff', fontSize: 18, fontWeight: 'bold', marginBottom: 20, textAlign: 'center' },
  progressBarContainer: { width: '80%', height: 8, backgroundColor: '#2c2c2e', borderRadius: 4, marginTop: 15, overflow: 'hidden' },
  progressBarFill: { height: '100%', backgroundColor: '#00e676', borderRadius: 4 },
  modalPercent: { color: '#00e676', fontSize: 16, fontWeight: 'bold', marginTop: 10 },
  cancelButton: { marginTop: 25, paddingVertical: 10, paddingHorizontal: 25, backgroundColor: 'rgba(255, 59, 48, 0.2)', borderRadius: 8, borderWidth: 1, borderColor: '#ff3b30' },
  cancelButtonText: { color: '#ff3b30', fontSize: 16, fontWeight: 'bold' },
});
