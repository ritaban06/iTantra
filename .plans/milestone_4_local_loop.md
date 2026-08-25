# Milestone 4 — Local Speech Loop

## Overview

Connect the STT and TTS engines into a complete local loop on a **single device**. This validates that the speech pipeline works end-to-end before adding networking complexity.

```
🎤 Speak
   ↓
AudioRecord (Kotlin)
   ↓
VAD (Kotlin)
   ↓
Vosk STT (Kotlin)
   ↓
Transcript + Confidence
   ↓
React Native (JS)
   ↓
Piper TTS (Kotlin)
   ↓
AudioTrack (Kotlin)
   ↓
🔊 Hear
```

No network, no encryption, no compression — pure local loop.

---

## Proposed Changes

### Kotlin

#### [NEW] `android/app/src/main/java/com/itantra/service/LocalLoopManager.kt`
```kotlin
class LocalLoopManager(
    private val sttModule: STTModule,
    private val ttsModule: TTSModule,
    private val audioCapture: AudioCaptureManager
) {
    fun startLoop()     // begin listening
    fun stopLoop()      // stop listening + TTS
    fun onSTTResult(result: STTResult)  // pipe STT → TTS

    // Echo prevention: pause AudioRecord during TTS playback
    fun onTTSStarted()   // mute microphone input
    fun onTTSStopped()   // resume microphone input
}
```

**Echo Prevention** is critical:
- When TTS is playing, `AudioRecord` must be paused or muted
- Otherwise the device's own TTS output feeds back into STT
- Use `AudioManager.MODE_IN_COMMUNICATION` + hardware AEC where available
- Fallback: software gate — discard audio frames during `TTS_STARTED → TTS_FINISHED`

#### [MODIFY] `android/app/src/main/java/com/itantra/audio/AudioCaptureManager.kt`
- Add `mute()` / `unmute()` methods
- When muted: continue reading but discard chunks (to avoid AudioRecord buffer starvation)

---

### JS Layer

#### [NEW] `src/services/LocalLoopService.js`
```javascript
class LocalLoopService {
  async start(language) {
    await NativeSTT.loadModel(language);
    await NativeTTS.loadModel(language);
    await NativeSTT.startListening(language);
    // Register STT result → TTS pipe
    this.sttSub = NativeSTT.onResult(async (result) => {
      if (result.confidence >= CONFIDENCE_THRESHOLD) {
        await NativeTTS.speak(result.transcript, language);
      } else {
        dispatch({ type: 'STT_LOW_CONFIDENCE', payload: result });
      }
    });
  }

  async stop() {
    await NativeSTT.stopListening();
    await NativeTTS.stop();
    this.sttSub?.remove();
  }
}
```

#### [NEW] `src/screens/LoopTestScreen.js` *(dev/debug only)*
- Large PTT button
- Real-time partial transcript display
- Confidence gauge
- TTS playback indicator
- Latency display: `STT: Xms | TTS: Xms | Total: Xms`
- Echo prevention status indicator

#### [MODIFY] `src/hooks/usePTT.js`
```javascript
// PTT state machine
// IDLE → PTT_HELD → LISTENING → PROCESSING_STT → SPEAKING_TTS → IDLE
```
- Hold PTT → start STT
- Release PTT → finalize STT (or VAD auto-ends)
- On result → auto-play TTS
- While TTS plays → PTT is disabled (half-duplex)

---

### State Machine (App-Level)

Introduce the full app state machine from the spec:

```
IDLE
  → PTT_HELD → LISTENING
  → LISTENING → PROCESSING_STT
  → PROCESSING_STT → PLAYING (local loop)
  → PROCESSING_STT → ENCODING (with networking)
  → PLAYING → IDLE
  → ERROR → IDLE (after dismiss)
```

#### [MODIFY] `src/state/appReducer.js`
Add all states:
```javascript
export const AppStates = {
  IDLE: 'IDLE',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  LISTENING: 'LISTENING',
  PROCESSING_STT: 'PROCESSING_STT',
  ENCODING: 'ENCODING',
  ENCRYPTING: 'ENCRYPTING',
  TRANSMITTING: 'TRANSMITTING',
  WAITING_ACK: 'WAITING_ACK',
  RECEIVING: 'RECEIVING',
  DECODING: 'DECODING',
  PROCESSING_TTS: 'PROCESSING_TTS',
  PLAYING: 'PLAYING',
  ERROR: 'ERROR',
};
```

#### [MODIFY] `src/screens/HomeScreen.js`
- PTT button shows state-based visual feedback:
  - `IDLE` → Mic icon, idle glow
  - `LISTENING` → Red pulse animation
  - `PROCESSING_STT` → Spinner + partial text
  - `PLAYING` → Speaker animation
  - `ERROR` → Error icon + message

---

### Latency Measurement

Timestamps captured at each stage:

```javascript
// JS side
const timestamps = {
  pttPressed: null,
  speechStart: null,   // from SPEECH_START event
  speechEnd: null,     // from SPEECH_END event
  sttResult: null,     // from STT_RESULT event
  ttsStarted: null,    // from TTS_STARTED event
  ttsFinished: null,   // from TTS_FINISHED event
};

// STT latency = sttResult - speechEnd
// TTS start latency = ttsStarted - sttResult
// Total local loop = ttsFinished - pttPressed
```

Displayed live on BenchmarkScreen.

---

## Concurrent Model Management

Both STT and TTS models may be in RAM simultaneously:
- Vosk small English: ~80 MB
- Piper medium English: ~60 MB
- Combined: ~140 MB

On devices with < 1.5 GB available RAM:
- Load STT model → run STT → result → load TTS model → synthesize
- Sequential loading adds ~200ms overhead but reduces peak RAM

#### [NEW] `src/services/ModelScheduler.js`
```javascript
// Decides whether to load models simultaneously or sequentially
// based on device RAM (queried via NativeDeviceInfo)
class ModelScheduler {
  async loadModelsForLanguage(language) { ... }
  async unloadModels() { ... }
}
```

---

## Verification Plan

### Manual
1. Open LoopTestScreen
2. Press PTT → speak "Hello, how are you?" → TTS repeats it back
3. Speak Hindi → TTS replies in Hindi
4. Confirm no echo/feedback loop occurs
5. Check latency readings in BenchmarkScreen
6. Confirm works on airplane mode
7. Test on low-RAM device (2 GB) — no OOM crash

### Performance Targets

| Metric | Target |
|---|---|
| STT latency (5 words, EN) | < 600 ms |
| TTS first audio (EN) | < 400 ms |
| Total local loop (EN) | < 1500 ms |
| Echo detected | None |
| OOM on 2GB device | None |
