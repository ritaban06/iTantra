# Implement Offline TTS (Milestone 3)

Integrate an on-device Text-to-Speech (TTS) engine that synthesizes speech from received text without any Internet connectivity. As per feedback, this will be split into two phases to ensure a stable MVP while resolving the complex C++ JNI phonemization pipeline required for Piper TTS.

## Phase 3A: Native TTS Architecture (Current Execution Target)

We will build the complete React Native ↔ Kotlin architecture and use Android's built-in `TextToSpeech` as the fallback engine. This ensures the app can handle TTS immediately for supported languages.

### Android Native Layer (Kotlin)
- **[NEW] `com.itantra.tts.TTSEngine.kt`**: A common interface for all TTS engines (`speak`, `stop`, `isAvailable`).
- **[NEW] `com.itantra.tts.AndroidTTSFallback.kt`**: Implements `TTSEngine` using Android's native `TextToSpeech` API.
- **[NEW] `com.itantra.tts.AudioOutputManager.kt`**: Abstraction for playing raw PCM audio (useful for Phase 3B and future low-bitrate encoders).
- **[NEW] `com.itantra.tts.TTSModelManager.kt`**: Resolves which engine/model to use based on the requested language.
- **[NEW] `com.itantra.tts.TTSModule.kt`**: React Native module exposing TTS controls (`speak`, `stop`) to the JavaScript layer.
- **[NEW] `com.itantra.tts.TTSPackage.kt`**: React Native package to register `TTSModule`.
- **[MODIFY] `MainApplication.kt`**: Register `TTSPackage()`.

### React Native Layer
- **[NEW] `src/native/NativeTTS.ts`**: JavaScript/TypeScript interface for the native TTS module.
- **[NEW] `src/hooks/useTTS.ts`**: React Hook managing TTS state (IDLE, SYNTHESIZING, PLAYING, DONE).
- **[MODIFY] `src/screens/ChatScreen.tsx`**: Tap message bubble to play TTS.
- **[MODIFY] `src/screens/AlertScreen.tsx`**: Auto-play alert messages at max comfortable volume.

---

## Phase 3B: Piper Integration (Future Work)

Once Phase 3A is stable, we will integrate Piper TTS ONNX models.

- **C++ JNI Phonemizer**: Investigate and implement a JNI wrapper for `piper-phonemize` (which uses `espeak-ng`) to convert text into phoneme IDs.
- **PiperTTSEngine.kt**: Implement `TTSEngine` using ONNX Runtime for Android, feeding the phoneme IDs to the ONNX model to generate raw PCM audio.
- **Model Assets**: Create a development script (`scripts/fetch_tts_models.ps1`) to download the `.onnx` and `.json` files into `android/app/src/main/assets/models/tts/` before building. (We will only bundle one language initially for testing to avoid bloating the APK).

## Verification Plan (For Phase 3A)

### Manual Verification
1. Build and run the Android app.
2. In the UI, trigger `NativeTTS.speak("Hello world", "en")` and verify English audio plays via Android TTS.
3. Trigger `NativeTTS.speak("नमस्ते दुनिया", "hi")` and verify Hindi audio plays.
4. Trigger `NativeTTS.speak("হ্যালো বিশ্ব", "bn")` and verify Bengali audio plays.
5. Send an ALERT message and confirm it plays automatically.
6. Verify no crashes occur if a language is not supported by the local Android TTS engine.
