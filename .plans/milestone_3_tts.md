# Milestone 3 — Offline TTS

## Overview

Integrate an on-device Text-to-Speech engine that synthesizes speech from received text without any Internet connectivity. The TTS system must support Indian languages, have a small model footprint, and produce intelligible audio with low RTF (Real-Time Factor).

**MVP languages**: English, Hindi, Bengali.

---

## Technology Selection

| Option | Size/lang | Indian Lang | Latency | License |
|---|---|---|---|---|
| **Piper TTS** (ONNX) | 30–60 MB | ✅ Good | Very Low | MIT |
| Coqui TTS | 100–200 MB | ✅ Good | Medium | MPL 2.0 |
| eSpeak-NG | ~5 MB | ✅ Passable | Very Low | GPL 3 |
| Android TTS (built-in) | 0 MB | ⚠️ Limited | Very Low | Proprietary |

> **Chosen strategy**:
> - **Primary**: Piper TTS via ONNX Runtime for Android (MIT, fast, small models, ONNX Runtime already available)
> - **Fallback**: Android built-in `TextToSpeech` for languages where Piper models aren't available yet
> This lets the app function immediately while progressively improving quality.

---

## Proposed Changes

### Kotlin — TTS Pipeline

#### [MODIFY] `android/app/build.gradle`
```groovy
// ONNX Runtime for Android (shared with STT if using ONNX Whisper later)
implementation 'com.microsoft.onnxruntime:onnxruntime-android:1.17.3'
```

#### [NEW] `android/app/src/main/java/com/itantra/tts/PiperTTSEngine.kt`
```kotlin
class PiperTTSEngine(private val modelPath: String, private val configPath: String) {
    fun loadModel(): Boolean
    suspend fun synthesize(text: String): ShortArray  // raw PCM 22050 Hz mono
    fun release()
}
```
- Loads Piper `.onnx` model + `.json` config from assets
- Runs ONNX inference on `Dispatchers.Default`
- Returns raw PCM audio (22050 Hz, 16-bit mono)
- Supports sentence-level streaming: synthesize sentence-by-sentence for lower latency

#### [NEW] `android/app/src/main/java/com/itantra/tts/AndroidTTSFallback.kt`
```kotlin
class AndroidTTSFallback(context: Context) : TextToSpeech.OnInitListener {
    fun speak(text: String, language: Locale)
    fun stop()
    fun setLanguage(language: Locale): Boolean
    fun isLanguageAvailable(language: Locale): Boolean
    fun release()
}
```
- Wraps Android `TextToSpeech` API
- Used when Piper model not available for selected language

#### [NEW] `android/app/src/main/java/com/itantra/tts/AudioOutputManager.kt`
```kotlin
class AudioOutputManager {
    fun playPCM(audioData: ShortArray, sampleRate: Int = 22050)
    fun playFromPiper(audioData: ShortArray)
    fun stop()
    fun setVolume(level: Float)
    val isPlaying: Boolean
}
```
- Uses `AudioTrack` (MODE_STREAM) for PCM playback
- Plays at full volume for emergency messages (respecting Android OS limits)
- Supports overlap detection (don't play TTS while PTT is active)

#### [MODIFY] `android/app/src/main/java/com/itantra/tts/TTSModule.kt`
Full React Native TurboModule:
```kotlin
@ReactModule(name = "NativeTTS")
class TTSModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
    @ReactMethod fun speak(text: String, language: String, isAlert: Boolean, promise: Promise)
    @ReactMethod fun stop(promise: Promise)
    @ReactMethod fun loadModel(language: String, promise: Promise)
    @ReactMethod fun unloadModel(promise: Promise)
    @ReactMethod fun isModelLoaded(language: String, promise: Promise)
    @ReactMethod fun setSpeakingRate(rate: Float, promise: Promise)
}
```
Events emitted to JS:
```
TTS_STARTED    { text, language }
TTS_FINISHED   { text, language, durationMs, rtf }
TTS_ERROR      { code, message }
TTS_MODEL_LOADED   { language }
```

#### [NEW] `android/app/src/main/java/com/itantra/tts/TTSModelManager.kt`
```kotlin
object TTSModelManager {
    // language → (modelPath, configPath)
    val modelRegistry: Map<String, Pair<String, String>>
    fun getModelForLanguage(language: String): TTSModelConfig?
    fun isModelAvailable(language: String): Boolean
    fun useFallback(language: String): Boolean
}
```
Model registry for MVP:
```
en → piper/en_US-lessac-medium.onnx + .json  (~55MB)
hi → piper/hi_IN-harini-medium.onnx + .json  (~45MB)
bn → piper/bn_IN-neutral-medium.onnx + .json (~40MB)
```

---

### Model Assets

#### [NEW] `android/app/src/main/assets/models/tts/`
```
tts/
├── en/
│   ├── en_US-lessac-medium.onnx
│   └── en_US-lessac-medium.onnx.json
├── hi/
│   ├── hi_IN-harini-medium.onnx
│   └── hi_IN-harini-medium.onnx.json
└── bn/
    ├── bn_IN-neutral-medium.onnx
    └── bn_IN-neutral-medium.onnx.json
```

---

### JS Layer

#### [MODIFY] `src/native/NativeTTS.js`
```javascript
export default {
  speak: (text, language, isAlert = false) => NativeTTS.speak(text, language, isAlert),
  stop: () => NativeTTS.stop(),
  loadModel: (language) => NativeTTS.loadModel(language),
  unloadModel: () => NativeTTS.unloadModel(),
  isModelLoaded: (language) => NativeTTS.isModelLoaded(language),
  onStarted: (cb) => emitter.addListener('TTS_STARTED', cb),
  onFinished: (cb) => emitter.addListener('TTS_FINISHED', cb),
  onError: (cb) => emitter.addListener('TTS_ERROR', cb),
};
```

#### [MODIFY] `src/hooks/useTTS.js`
```javascript
// Returns: { isSpeaking, lastRTF, speak, stop, error }
```
- State: `IDLE → SYNTHESIZING → PLAYING → DONE`
- On `TTS_FINISHED`: record RTF in state (for BenchmarkScreen)
- On `TTS_ERROR`: show error notification

#### [MODIFY] `src/screens/ChatScreen.js`
- Tap message bubble → `NativeTTS.speak(message.text, message.language)`
- Show speaker icon animation while playing
- Alert messages auto-play on receipt

#### [MODIFY] `src/screens/AlertScreen.js`
- Auto-play TTS at max comfortable volume
- Show "Playing alert…" spinner
- STOP button calls `NativeTTS.stop()`

---

## RTF Measurement

RTF is measured inside `TTSModule.kt`:
```kotlin
val startMs = System.currentTimeMillis()
val audio = piperEngine.synthesize(text)
val synthMs = System.currentTimeMillis() - startMs
val audioDurationMs = (audio.size.toDouble() / 22050.0 * 1000.0).toLong()
val rtf = synthMs.toDouble() / audioDurationMs.toDouble()
// Emitted in TTS_FINISHED event
```

---

## Error Handling

| Error | Recovery |
|---|---|
| `MODEL_NOT_FOUND` | Fall back to Android TTS |
| `ONNX_INFERENCE_FAILED` | Fall back to Android TTS, log error |
| `AUDIO_FOCUS_DENIED` | Queue message, retry on focus gain |
| `TTS_FAILED` | Show error in chat, log code |

---

## Alert Audio Strategy

For `ALERT` type messages:
1. Request `AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE`
2. Set volume to user-preferred alert level (not forced max, respects OS)
3. Play Piper TTS
4. Release audio focus after playback
5. Repeat once automatically for critical alerts

---

## Verification Plan

### Automated
```bash
./gradlew :app:testDebugUnitTest --tests "com.itantra.tts.*"
```

### Manual
1. Receive mock message "Send help immediately" → TTS plays in English
2. Switch language to Hindi → TTS plays in Hindi
3. Send ALERT message → auto-plays, full-volume
4. RTF displayed correctly in BenchmarkScreen (< 1.0 = real-time)
5. Airplane mode enabled → TTS still works
6. Back-to-back messages → queue plays correctly

---

## Performance Targets

| Metric | Target |
|---|---|
| Time to First Audio (English) | < 400 ms |
| RTF (Piper medium) | < 0.5 |
| Model RAM (Piper medium) | < 100 MB |
| Peak CPU during synthesis | < 50% |
| Audio quality (MOS) | > 3.5 |
