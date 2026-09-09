import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  PermissionsAndroid,
  Platform,
  NativeModules,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import NativeSherpa, { SherpaStatus, VadSegment } from '../native/NativeSherpa';

/**
 * EXPERIMENTAL diagnostic screen for the sherpa-onnx speech runtime
 * (Android Speech Integration Gate). NOT a production UI — it exists so a
 * colleague can validate the experimental engines on a real Android phone.
 *
 * Production screens (Home, Connect, …) and speech contracts are untouched.
 */

const EN_TEST_SENTENCE = 'The quick brown fox jumps over the lazy dog';
const HI_TEST_SENTENCE = 'नमस्कार दोस्तों यह एक परीक्षण वाक्य है';

export default function SherpaDiagnosticScreen() {
  const [status, setStatus] = useState<SherpaStatus | null>(null);
  const [partial, setPartial] = useState('');
  const [finalResult, setFinalResult] = useState('');
  const [hiResult, setHiResult] = useState('');
  const [ttsResult, setTtsResult] = useState('');
  const [vadSegments, setVadSegments] = useState<VadSegment[]>([]);
  const [enText, setEnText] = useState(EN_TEST_SENTENCE);
  const [hiText, setHiText] = useState(HI_TEST_SENTENCE);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [micActive, setMicActive] = useState(false);

  const nativeAvailable = !!(NativeModules && NativeModules.NativeSherpa);

  const pushLog = useCallback((line: string) => {
    setLog((prev) => [...prev.slice(-19), `${new Date().toLocaleTimeString()} ${line}`]);
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await NativeSherpa.getStatus());
    } catch (e: any) {
      pushLog(`status error: ${e?.message ?? e}`);
    }
  }, [pushLog]);

  useEffect(() => {
    const requestPerm = async () => {
      if (Platform.OS === 'android') {
        try {
          await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
        } catch (e) {
          pushLog(`permission error: ${String(e)}`);
        }
      }
    };
    requestPerm();
    refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const subs = [
      NativeSherpa.onPartial((e) => setPartial(e.text)),
      NativeSherpa.onResult((e) => {
        setFinalResult(e.text);
        setPartial('');
      }),
      NativeSherpa.onError((e) => pushLog(`EVENT ${e.code}: ${e.message}`)),
    ];
    return () => subs.forEach((s) => s.remove());
  }, [pushLog]);

  const run = async (label: string, fn: () => Promise<any>) => {
    if (busy) {
      pushLog(`busy (${busy}) — ${label} ignored`);
      return;
    }
    setBusy(label);
    try {
      await fn();
    } catch (e: any) {
      pushLog(`${label} FAILED: ${e?.message ?? e}`);
    } finally {
      setBusy(null);
      refreshStatus();
    }
  };

  const startListening = () =>
    run('start mic', async () => {
      await NativeSherpa.startListening();
      setMicActive(true);
      setPartial('');
      setFinalResult('');
      pushLog('mic started (English streaming)');
    });

  const stopListening = () =>
    run('stop mic', async () => {
      const res = await NativeSherpa.stopListening();
      setMicActive(false);
      if (res.text) setFinalResult(res.text);
      setPartial('');
      pushLog(`mic stopped; final="${res.text}"`);
    });

  const captureHindi = () =>
    run('Hindi capture (8s)', async () => {
      setHiResult('');
      pushLog('speak the Hindi sentence within 8 seconds…');
      const res = await NativeSherpa.captureOfflineUtterance(8000);
      setHiResult(res.text);
      pushLog(`Hindi transcript (${res.pcmBytes} PCM bytes): ${res.text}`);
    });

  const runVad = () =>
    run('VAD mic test (10s)', async () => {
      setVadSegments([]);
      pushLog('VAD test: stay silent 2s, speak 5s, stay silent 3s…');
      const segs = await NativeSherpa.runVadTest(10000);
      setVadSegments(segs);
      pushLog(`VAD segments found: ${segs.length}`);
    });

  const statusLine = () => {
    if (!status) return 'unknown';
    const parts: string[] = [];
    parts.push(status.sttStreaming ? 'STT(en) ✓' : status.sttOffline ? 'STT(hi offline) ✓' : 'STT ✗');
    parts.push(status.tts ? 'TTS ✓' : 'TTS ✗');
    parts.push(status.vad ? 'VAD ✓' : 'VAD ✗');
    return parts.join(' · ');
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Sherpa Speech Diagnostics (EXPERIMENTAL)</Text>
        <Text style={styles.note}>
          For physical-device validation only. Hindi STT is offline NeMo-CTC — utterance-only, NOT
          streaming. All models are packaged assets; no network used.
        </Text>

        {/* Module + status */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Runtime</Text>
          <Text style={styles.rowText}>
            Native module: {nativeAvailable ? 'AVAILABLE ✓' : 'MISSING ✗'}
          </Text>
          <Text style={styles.rowText}>Loaded: {statusLine()}</Text>
          {busy ? <Text style={styles.busyText}>busy: {busy}…</Text> : null}
          <Button label="Refresh status" onPress={refreshStatus} />
        </View>

        {/* English STT */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>English STT (streaming zipformer)</Text>
          <Row>
            <Button
              label="Load EN STT"
              disabled={busy !== null}
              onPress={() =>
                run('load EN STT', async () => {
                  const r = await NativeSherpa.loadSTT('en');
                  pushLog(`EN STT loaded (streaming=${r.isStreaming})`);
                })
              }
            />
            {!micActive ? (
              <Button label="Start mic" disabled={busy !== null} onPress={startListening} />
            ) : (
              <Button label="Stop mic" onPress={stopListening} />
            )}
          </Row>
          {partial ? <Text style={styles.partial}>partial: {partial}</Text> : null}
          {finalResult ? <Text style={styles.result}>final: {finalResult}</Text> : null}
        </View>

        {/* Hindi STT */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Hindi STT (offline NeMo-CTC)</Text>
          <Row>
            <Button
              label="Load HI STT"
              disabled={busy !== null}
              onPress={() =>
                run('load HI STT', async () => {
                  const r = await NativeSherpa.loadSTT('hi');
                  pushLog(`HI STT loaded (streaming=${r.isStreaming} — offline path)`);
                })
              }
            />
            <Button label="Capture 8s + transcribe" disabled={busy !== null} onPress={captureHindi} />
          </Row>
          <Text style={styles.note}>Speak: {HI_TEST_SENTENCE}</Text>
          {hiResult ? <Text style={styles.result}>Hindi: {hiResult}</Text> : null}
        </View>

        {/* TTS */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>MMS VITS TTS</Text>
          <Text style={styles.label}>English</Text>
          <TextInput
            style={styles.input}
            value={enText}
            onChangeText={setEnText}
            placeholder="English text"
            placeholderTextColor="#555"
          />
          <Row>
            <Button
              label="Load EN TTS"
              disabled={busy !== null}
              onPress={() => run('load EN TTS', async () => NativeSherpa.loadTTS('en'))}
            />
            <Button
              label="Speak EN"
              disabled={busy !== null}
              onPress={() =>
                run('speak EN', async () => {
                  const r = await NativeSherpa.speak(enText, 'en');
                  setTtsResult(`spoken ${r.durationMs} ms`);
                })
              }
            />
          </Row>
          <Text style={styles.label}>Hindi</Text>
          <TextInput
            style={styles.input}
            value={hiText}
            onChangeText={setHiText}
            placeholder="Hindi text"
            placeholderTextColor="#555"
          />
          <Row>
            <Button
              label="Load HI TTS"
              disabled={busy !== null}
              onPress={() => run('load HI TTS', async () => NativeSherpa.loadTTS('hi'))}
            />
            <Button
              label="Speak HI"
              disabled={busy !== null}
              onPress={() =>
                run('speak HI', async () => {
                  const r = await NativeSherpa.speak(hiText, 'hi');
                  setTtsResult(`spoken ${r.durationMs} ms`);
                })
              }
            />
            <Button label="Stop" onPress={() => run('stop TTS', () => NativeSherpa.stopSpeaking())} />
          </Row>
          {ttsResult ? <Text style={styles.result}>{ttsResult}</Text> : null}
        </View>

        {/* VAD */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Silero VAD</Text>
          <Row>
            <Button
              label="Load VAD"
              disabled={busy !== null}
              onPress={() => run('load VAD', () => NativeSherpa.loadVAD())}
            />
            <Button label="Run 10s mic VAD test" disabled={busy !== null} onPress={runVad} />
          </Row>
          <Text style={styles.note}>Expected: silence → no segments; speech → segments appear.</Text>
          {vadSegments.length > 0 ? (
            <View>
              <Text style={styles.result}>Segments ({vadSegments.length}):</Text>
              {vadSegments.map((s, i) => (
                <Text key={i} style={styles.rowText}>
                  #{i + 1}: start {Math.round(s.startSample / 16)} ms · dur{' '}
                  {Math.round(s.numSamples / 16)} ms
                </Text>
              ))}
            </View>
          ) : vadSegments.length === 0 && busy === null && status?.vad ? (
            <Text style={styles.result}>No speech segments detected in the last test.</Text>
          ) : null}
        </View>

        {/* Release */}
        <View style={styles.card}>
          <Button
            label="Release all resources"
            disabled={busy !== null}
            onPress={() =>
              run('release all', async () => {
                await NativeSherpa.releaseAll();
                setMicActive(false);
                setPartial('');
                setFinalResult('');
                setHiResult('');
                setVadSegments([]);
                pushLog('all experimental resources released');
              })
            }
          />
        </View>

        {/* Log */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Log</Text>
          {log.length === 0 ? (
            <Text style={styles.rowText}>(empty)</Text>
          ) : (
            log.map((l, i) => (
              <Text key={i} style={styles.logLine}>
                {l}
              </Text>
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Button(props: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <TouchableOpacity
      style={[styles.button, props.disabled && styles.buttonDisabled]}
      onPress={props.onPress}
      disabled={props.disabled}
    >
      <Text style={styles.buttonText}>{props.label}</Text>
    </TouchableOpacity>
  );
}

function Row(props: { children: React.ReactNode }) {
  return <View style={styles.row}>{props.children}</View>;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0c' },
  content: { padding: 12, paddingBottom: 40 },
  title: { color: '#00e676', fontSize: 20, fontWeight: '900', marginBottom: 6 },
  note: { color: '#8e8e93', fontSize: 12, marginTop: 6 },
  card: {
    backgroundColor: '#1c1c1e',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2c2c2e',
    padding: 12,
    marginTop: 10,
  },
  cardTitle: { color: '#fff', fontSize: 15, fontWeight: '700', marginBottom: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  button: {
    backgroundColor: '#2c2c2e',
    borderColor: '#48484a',
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginRight: 8,
    marginBottom: 6,
  },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  label: { color: '#8e8e93', fontSize: 12, marginTop: 8 },
  input: {
    backgroundColor: '#111114',
    color: '#fff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#2c2c2e',
    padding: 8,
    marginTop: 4,
    fontSize: 14,
  },
  partial: { color: '#ffcc00', fontSize: 13, marginTop: 8 },
  result: { color: '#00e676', fontSize: 14, fontWeight: '600', marginTop: 8 },
  rowText: { color: '#aaa', fontSize: 13, marginTop: 4 },
  busyText: { color: '#ffcc00', fontSize: 13, marginTop: 4, fontWeight: '700' },
  logLine: { color: '#8e8e93', fontSize: 11, marginTop: 2, fontFamily: 'monospace' },
});