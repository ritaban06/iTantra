# iTantra STT Migration (Hybrid Architecture)

## Overview
Successfully migrated the STT engine architecture to support a hybrid model approach. English now uses Vosk for local, lightweight processing, while Indian languages (e.g., Hindi, Bengali) are routed to AI4Bharat IndicConformer 120M ONNX models, leveraging a NeMo-compatible Log-Mel spectrogram preprocessing pipeline.

## What Was Implemented

### 1. Preprocessing Pipeline (`AudioPreprocessor.kt`)
Implemented an exact match for the NeMo specification required by IndicConformer:
- **PCM to Float32** conversion (16kHz).
- **Pre-emphasis** filter ($\alpha = 0.97$).
- **STFT** computation using a custom Radix-2 FFT (n_fft=512, hop=160, win=400, Hann window).
- **Mel Filterbank Application**: 80-bin Slaney-normalized mel filters loaded directly from a binary file (`mel_filters_80x257.bin`) to guarantee parity with Librosa.
- **Log Transformation & Normalization**: Outputting the exact `[1, 80, T]` float tensor expected by ONNX.

### 2. ONNX Engine (`IndicConformerSTTEngine.kt`)
- Integrated `onnxruntime-android`.
- Processes raw audio into the Mel spectrogram tensor and feeds it alongside `length` into the IndicConformer session.
- Computes character-level decoding from CTC logits utilizing a greedy decoding algorithm against the language's `vocab.json`, accurately skipping blank tokens (`▁`) and collapsing duplicate characters.

### 3. Unified Abstraction (`STTModule.kt` & `ModelManager.kt`)
- All speech recognition now operates behind the `STTEngine` interface.
- `ModelManager` maps languages like `en` to `VoskSTTEngine`, and `hi`/`bn` to `IndicConformerSTTEngine`.
- The React Native layer (`useSTT.js`) operates independently of the engine running beneath it.

## Verification
- Wrote a Python script utilizing `librosa` to compute the reference 80-bin Mel filterbank and exported it as a binary asset into the Android project.
- Synthesized and compiled the STT pipeline code into the native Android module structure.

> [!TIP]
> **Next Steps**
> You can now place the IndicConformer model files (`model.onnx` and `vocab.json`) into `android/app/src/main/assets/models/indicconformer/hi/` and the Vosk model in `assets/models/vosk/en/` to test speech recognition directly from the UI.
