# Milestone 2 — Offline STT

## Overview

Integrate an on-device Speech-to-Text engine into iTantra. Audio is captured via Android `AudioRecord`, passed through a Voice Activity Detector, and fed into a local STT model. The result (transcript + confidence) is emitted as a React Native event.

No Internet request is made at any point in this pipeline.

**MVP languages**: English, Hindi, Bengali (expandable in Milestone 11).

---

## Technology Selection

| Option | Model Size | Indian Lang | Offline | License |
|---|---|---|---|---|
| **Vosk** | 50–80 MB/lang | ✅ Good | ✅ | Apache 2.0 |
| Whisper.cpp | 75–150 MB | ✅ Excellent | ✅ | MIT |
| ONNX Whisper | 80–160 MB | ✅ Excellent | ✅ | MIT |
| Android SpeechRecognizer | 0 MB | ⚠️ Cloud | ❌ | N/A |

> **Chosen for MVP**: Vosk (Apache 2.0, pre-built Android `.aar`, 40–80 MB per language, works out of the box with Kotlin JNI). Whisper can replace it in Milestone 11 after benchmarking.

---

## Proposed Changes

### Kotlin — Audio + STT Pipeline

#### [MODIFY] `android/app/build.gradle`
- Add Vosk Android dependency: `com.alphacephei:vosk-android:0.3.47`
- Add `abiFilters` for `arm64-v8a`, `armeabi-v7a`

#### [NEW] `android/app/src/main/java/com/itantra/audio/AudioCaptureManager.kt`
```
AudioRecord (16kHz, mono, PCM_16BIT)
    ↓
RingBuffer (circular, 512-frame chunks)
    ↓
VAD (WebRTC VAD or energy threshold)
    ↓
Speech segments → STTEngine
    ↓
Transcript + Confidence
```
- `startCapture()` — opens AudioRecord, starts read loop in Coroutine
- `stopCapture()` — closes AudioRecord, drains buffer
- `onAudioChunk(ByteArray)` — callback for VAD
- Handles `AudioRecord.ERROR_INVALID_OPERATION` gracefully

#### [NEW] `android/app/src/main/java/com/itantra/audio/VoiceActivityDetector.kt`
- Energy-based VAD (simple, fast)
- `isSpeech(chunk: ShortArray): Boolean`
- State machine: `SILENCE → PRE_SPEECH → SPEECH → POST_SPEECH`
- Configurable silence threshold (default: 300ms) and energy threshold
- Emits `SPEECH_START`, `SPEECH_END` events

#### [NEW] `android/app/src/main/java/com/itantra/stt/VoskSTTEngine.kt`
```kotlin
class VoskSTTEngine(private val modelPath: String) {
    fun loadModel(): Boolean
    fun startRecognition()
    fun feedChunk(data: ByteArray)
    fun getFinalResult(): STTResult?     // transcript + confidence
    fun reset()
    fun release()
}

data class STTResult(
    val transcript: String,
    val confidence: Float,
    val language: String,
    val durationMs: Long
)
```
- Uses `org.vosk.Model` and `org.vosk.Recognizer`
- Runs in background Coroutine (`Dispatchers.Default`)
- Emits partial results during speech
- Final result on `SPEECH_END`

#### [MODIFY] `android/app/src/main/java/com/itantra/stt/STTModule.kt`
Full React Native TurboModule implementation:
```kotlin
@ReactModule(name = "NativeSTT")
class STTModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
    @ReactMethod fun startListening(language: String, promise: Promise)
    @ReactMethod fun stopListening(promise: Promise)
    @ReactMethod fun loadModel(language: String, promise: Promise)
    @ReactMethod fun unloadModel(promise: Promise)
    @ReactMethod fun isModelLoaded(language: String, promise: Promise)
}
```
Events emitted to JS:
```
STT_RESULT         { transcript, confidence, language, durationMs }
STT_PARTIAL        { partial, language }
STT_ERROR          { code, message }
STT_MODEL_LOADED   { language }
STT_MODEL_FAILED   { language, error }
SPEECH_START       {}
SPEECH_END         {}
```

#### [NEW] `android/app/src/main/java/com/itantra/stt/ModelManager.kt`
```kotlin
object ModelManager {
    fun getModelPath(language: String): String?
    fun isModelAvailable(language: String): Boolean
    fun listAvailableModels(): List<String>
}
```
- Models stored in `assets/models/stt/<lang>/` or app internal storage
- Language → model path mapping:
  ```
  en → vosk-model-small-en-us
  hi → vosk-model-hi-0.22
  bn → vosk-model-bn-0.2
  ```

#### [NEW] `android/app/src/main/java/com/itantra/MainApplication.kt` (modify)
- Register `STTModule` in `ReactPackage`

---

### JS Layer

#### [MODIFY] `src/native/NativeSTT.js`
```javascript
import { NativeModules, NativeEventEmitter } from 'react-native';

const { NativeSTT } = NativeModules;
const emitter = new NativeEventEmitter(NativeSTT);

export default {
  startListening: (language) => NativeSTT.startListening(language),
  stopListening: () => NativeSTT.stopListening(),
  loadModel: (language) => NativeSTT.loadModel(language),
  unloadModel: () => NativeSTT.unloadModel(),
  isModelLoaded: (language) => NativeSTT.isModelLoaded(language),
  onResult: (cb) => emitter.addListener('STT_RESULT', cb),
  onPartial: (cb) => emitter.addListener('STT_PARTIAL', cb),
  onError: (cb) => emitter.addListener('STT_ERROR', cb),
  onSpeechStart: (cb) => emitter.addListener('SPEECH_START', cb),
  onSpeechEnd: (cb) => emitter.addListener('SPEECH_END', cb),
};
```

#### [MODIFY] `src/hooks/useSTT.js`
```javascript
// Returns: { transcript, confidence, isListening, isModelLoaded, error, startListening, stopListening }
```
- Subscribes to all STT events
- State: `IDLE → LOADING_MODEL → READY → LISTENING → PROCESSING → RESULT`
- Low confidence (< 0.6) triggers `STT_LOW_CONFIDENCE` state
- Exposes `requiresConfirmation: boolean` when confidence < threshold

#### [MODIFY] `src/screens/HomeScreen.js`
- Connect PTT button to `useSTT` hook
- Show partial transcript in real-time
- Show confidence badge
- Show "Too quiet, please repeat" on low confidence

---

### Model Asset Bundling

#### [NEW] `android/app/src/main/assets/models/stt/`
```
stt/
├── en/      # vosk-model-small-en-us (~40MB)
├── hi/      # vosk-model-hi-0.22 (~75MB)
└── bn/      # vosk-model-bn-0.2 (~50MB)
```
> **Note**: Models are large. Only MVP models bundled. Others downloaded post-install from a configurable local server (not cloud) or preloaded by the user.

---

### Android Permissions Added

```xml
<uses-permission android:name="android.permission.RECORD_AUDIO" />
```
Runtime permission request in `HomeScreen.js` before first STT use.

---

## STT Confidence Strategy

| Confidence | Action |
|---|---|
| ≥ 0.85 | Auto-send |
| 0.60 – 0.85 | Show transcript + [SEND] [REPEAT] |
| < 0.60 | Show "Speech unclear. Please repeat." |

For ALERT-type messages: threshold raised to 0.80 for auto-send.

---

## Error Handling

| Error | Recovery |
|---|---|
| `MODEL_NOT_FOUND` | Show language download prompt |
| `INSUFFICIENT_MEMORY` | Unload current model, prompt user |
| `AUDIO_PERMISSION_DENIED` | Show settings redirect |
| `STT_FAILED` | Show retry option, log error code |

---

## Verification Plan

### Automated
```bash
# Unit test: STTResult data class, ModelManager path resolution
./gradlew :app:testDebugUnitTest --tests "com.itantra.stt.*"
```

### Manual
1. PTT button → speak "Send help to sector 4" in English → correct transcript appears
2. Switch to Hindi → speak → correct Devanagari transcript
3. Cover microphone → "Speech unclear" message appears
4. Disable model file → `MODEL_NOT_FOUND` error displayed
5. Verify no Internet request is made (airplane mode test)
6. Benchmark: STT latency < 800ms for 5-word utterance on mid-range device

---

## Performance Targets

| Metric | Target |
|---|---|
| STT Latency (English) | < 600 ms |
| STT Latency (Hindi) | < 800 ms |
| WER (English) | < 15% |
| WER (Hindi) | < 25% |
| Model RAM (Vosk small) | < 120 MB |
| Peak CPU during STT | < 60% |
