# Migrate STT to Hybrid Vosk & IndicConformer (ONNX)

Migrate the offline Speech-to-Text (STT) architecture to a hybrid model that uses Vosk for English and the AI4Bharat IndicConformer 120M ONNX models for the 9 Indian languages. This provides the best of both worlds: offline, highly accurate transcription across 10 languages without the complexity of the massive 600M parameter model.

## User Review Required

> [!IMPORTANT]
> **Mel Filterbank Binary Asset**
> The plan specifies using Slaney normalization for the 80-bin Mel filterbank and recommends generating the `mel_filters_80x257.bin` in Python and loading it as an asset in Android to avoid precision issues. Should I write a quick Python script to generate this binary file and include it in the project, or do you already have the binary available? 

> [!WARNING]
> **Model Bundling vs Downloading**
> To avoid a 4.2 GB APK, we will only bundle English (Vosk) and Hindi (IndicConformer) for the initial MVP development. Other models will eventually be downloaded at runtime in the final app. I will place the Hindi `model.onnx` and `vocab.json` in `assets/models/indicconformer/hi/` and the Vosk model in `assets/models/vosk/en/`. 

## Proposed Changes

### Kotlin Audio Pipeline & Preprocessing
---
#### [NEW] [AudioPreprocessor.kt](file:///d:/projects/iTantra/android/app/src/main/java/com/itantra/audio/AudioPreprocessor.kt)
Implement exact NeMo-compatible preprocessing for IndicConformer:
- **PCM to Float32** conversion (16kHz mono).
- **Pre-emphasis** (α = 0.97).
- **STFT** (n_fft=512, win_length=400, hop_length=160, Hann window).
- **Mel Filterbank** (80-bin, Slaney normalization, fmin=0, fmax=8000).
- **Log transformation**: `log(x + 2^-24)`.
- **Normalization**: Per-bin normalization using unbiased sample standard deviation (ddof=1).

### Kotlin STT Engines
---
#### [NEW] [STTEngine.kt](file:///d:/projects/iTantra/android/app/src/main/java/com/itantra/stt/STTEngine.kt)
- Create a common interface for STT (`startRecognition()`, `feedChunk()`, `reset()`, etc.).

#### [MODIFY] [VoskSTTEngine.kt](file:///d:/projects/iTantra/android/app/src/main/java/com/itantra/stt/VoskSTTEngine.kt)
- Update to implement the `STTEngine` interface. Used exclusively for English.

#### [NEW] [IndicConformerSTTEngine.kt](file:///d:/projects/iTantra/android/app/src/main/java/com/itantra/stt/IndicConformerSTTEngine.kt)
- Implement `STTEngine` using `com.microsoft.onnxruntime:onnxruntime-android:1.17.3`.
- Process incoming audio through `AudioPreprocessor`.
- Create `audio_signal` (float32 `[1, 80, T]`) and `length` (int64) tensors.
- Run ONNX inference to get CTC logits.
- Implement Greedy CTC Decoder to handle argmax, consecutive duplicate collapse, and blank token removal using the provided `vocab.json`.

#### [MODIFY] [ModelManager.kt](file:///d:/projects/iTantra/android/app/src/main/java/com/itantra/stt/ModelManager.kt)
- Refactor to use `LanguageConfig` and `EngineType` (VOSK vs INDIC_CONFORMER).
- Route "en" to Vosk, and "hi", "bn", etc., to IndicConformer.

#### [MODIFY] [STTModule.kt](file:///d:/projects/iTantra/android/app/src/main/java/com/itantra/stt/STTModule.kt)
- Update to use the abstracted `ModelManager` and `STTEngine` architecture without hardcoding Vosk logic.

### React Native Layer
---
#### [MODIFY] [useSTT.ts](file:///d:/projects/iTantra/src/hooks/useSTT.ts) (or `.js`)
- Update the language codes to match (`en`, `hi`, `bn`, `gu`, `mr`, `kn`, `ml`, `ta`, `te`, `or`).
- Ensure no automatic language detection is triggered.

## Verification Plan

### Automated Tests
- Unit test the `AudioPreprocessor.kt` to ensure STFT and Mel calculations are stable (possibly comparing against known Librosa outputs if available).

### Manual Verification
1. Download Hindi IndicConformer and English Vosk models.
2. Build Android App.
3. Select Hindi -> Speak -> Verify correct Hindi transcript.
4. Select English -> Speak -> Verify correct English transcript.
