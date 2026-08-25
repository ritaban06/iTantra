# iTantra — Implementation Plan

## Overview

iTantra is an Android-first offline multilingual emergency communication app (SIH Problem #26173). It converts speech to text locally, transmits compact encrypted text packets over BLE/Wi-Fi Direct, and reconstructs speech on the receiver.

This plan covers the **initial scaffolding and Milestone 1** (React Native UI with mock data), establishing the full React Native + Kotlin project structure aligned to the spec.

---

## Proposed Changes

### Phase 1 — React Native App Bootstrap

Initialize a bare React Native project using `npx @react-native-community/cli init` targeting the existing directory. This sets up the Android Gradle project, Metro bundler, and JS entry point.

#### [NEW] `package.json` — RN project root
#### [NEW] `index.js` — App entry point
#### [NEW] `App.js` — Root component with navigator

---

### Phase 2 — `src/` JS Architecture

Follows the spec's recommended structure exactly.

```
src/
├── screens/
│   ├── HomeScreen.js           # Home + PTT button
│   ├── ChatScreen.js           # Message history
│   ├── ConnectScreen.js        # Device discovery & connection
│   ├── LanguageScreen.js       # Language selector (10 languages)
│   ├── AlertScreen.js          # Emergency alert receiver
│   ├── SettingsScreen.js       # Profile, device ID, preferences
│   └── BenchmarkScreen.js      # Dev performance dashboard
│
├── components/
│   ├── PTTButton.js            # Push-to-talk button with states
│   ├── MessageBubble.js        # Chat bubble (NORMAL / ALERT)
│   ├── DeviceCard.js           # Discovered device card
│   ├── ConnectionStatus.js     # BLE/WiFi status bar
│   ├── LanguagePicker.js       # Language selector component
│   ├── AlertBanner.js          # Emergency alert overlay
│   └── BenchmarkCard.js        # Performance metric card
│
├── navigation/
│   └── AppNavigator.js         # Stack + bottom-tab navigator
│
├── hooks/
│   ├── useSTT.js               # STT state + native calls
│   ├── useTTS.js               # TTS state + native calls
│   ├── useBLE.js               # BLE state + native events
│   ├── usePTT.js               # Push-to-talk logic
│   └── useAppState.js          # Global app state machine
│
├── services/
│   ├── CommunicationService.js # High-level: send/receive messages
│   ├── ProtocolService.js      # Packet encode/decode (JS side)
│   ├── CompressionService.js   # zlib-based JS compression stub
│   └── MessageQueue.js         # Outgoing message queue
│
├── native/
│   ├── NativeSTT.js            # JS wrapper for NativeSTTModule
│   ├── NativeTTS.js            # JS wrapper for NativeTTSModule
│   ├── NativeBLE.js            # JS wrapper for NativeBLEModule
│   ├── NativeWifiDirect.js     # JS wrapper for NativeWifiDirectModule
│   └── NativeDeviceInfo.js     # JS wrapper for NativeDeviceInfoModule
│
├── state/
│   ├── appReducer.js           # State machine reducer
│   ├── messageReducer.js       # Message list state
│   └── AppContext.js           # React context + providers
│
├── protocol/
│   ├── PacketBuilder.js        # Binary packet construction
│   ├── PacketParser.js         # Binary packet parsing
│   └── MessageTypes.js        # NORMAL, IMPORTANT, ALERT, ACK, etc.
│
├── utils/
│   ├── deviceId.js             # Generate ITN-XXXX-XXXX ID
│   ├── logger.js               # Dev-safe logger (no sensitive data)
│   └── formatters.js           # Timestamp, byte formatting
│
└── constants/
    ├── languages.js            # 10 supported languages
    ├── appStates.js            # IDLE, LISTENING, PROCESSING_STT...
    └── errorCodes.js           # All error constants
```

---

### Phase 3 — Android Native Layer (Kotlin)

Create stub/interface-ready Kotlin modules that will be integrated with actual STT/TTS/BLE implementations in later milestones.

```
android/app/src/main/java/com/itantra/
├── audio/
│   └── AudioCaptureModule.kt       # AudioRecord + VAD stub
├── stt/
│   └── STTModule.kt                # Native module: startListening, stopListening, loadModel
├── tts/
│   └── TTSModule.kt                # Native module: speak, stop (Android TTS for MVP)
├── ble/
│   └── BLEModule.kt                # Native module: scan, advertise, connect, send
├── wifi/
│   └── WifiDirectModule.kt         # Native module stub
├── transport/
│   └── TransportManager.kt         # Routes between BLE and WiFi
├── protocol/
│   └── PacketCodec.kt              # Binary packet encode/decode
├── crypto/
│   └── CryptoManager.kt            # AES-256-GCM encryption
├── compression/
│   └── CompressManager.kt          # Compression (zstd/deflate)
└── service/
    └── CommunicationService.kt     # Android Foreground Service
```

---

### Phase 4 — Android Manifest & Permissions

```xml
<!-- AndroidManifest.xml permissions -->
BLUETOOTH
BLUETOOTH_ADMIN
BLUETOOTH_SCAN
BLUETOOTH_ADVERTISE
BLUETOOTH_CONNECT
ACCESS_FINE_LOCATION
ACCESS_WIFI_STATE
CHANGE_WIFI_STATE
CHANGE_NETWORK_STATE
RECORD_AUDIO
FOREGROUND_SERVICE
```

---

### Phase 5 — Additional Project Files

```
models/
  stt/      # (empty, placeholder for STT model files)
  tts/      # (empty, placeholder for TTS model files)
tools/
  benchmark/
  conversion/
docs/
  architecture/
  protocol/
  security/
tests/
.gitignore
README.md
```

---

## Open Questions

> [!IMPORTANT]
> **STT Runtime Selection**: The spec requires offline STT for Hindi/Bengali/English for MVP. Do you want to use **Vosk** (good Indian language support, small models ~50MB) or **Whisper.cpp** (better accuracy, larger ~75-150MB)? Or should we start with Android's built-in `SpeechRecognizer` (requires no model download but may need internet) as a temporary placeholder?

> [!IMPORTANT]
> **TTS Runtime**: For offline TTS, do you want to use **Android's built-in TextToSpeech** (no model download needed, may lack some Indian languages) as the MVP placeholder, or go straight to an offline solution like **eSpeak-NG** or **Coqui TTS**?

> [!IMPORTANT]
> **React Native Version**: Should I use the latest React Native (0.79.x with New Architecture) or a more stable version (0.74.x/0.75.x)?

> [!NOTE]
> **For this initial build**: I will scaffold the complete project with mock data for the UI (Milestone 1), and implement **Android TTS** + **Vosk STT** as the native stub implementations (ready to swap for better models later). BLE will be a working stub with proper event emission.

---

## Verification Plan

### Manual Verification
1. `npm run android` builds and launches app on emulator/device
2. All 7 screens are navigable
3. PTT button shows correct state transitions
4. Language selector shows all 10 languages
5. Mock messages render in chat
6. Emergency alert overlay displays correctly
7. Benchmark dashboard shows (mocked) metrics
8. Device ID is generated on first launch (`ITN-XXXX-XXXX` format)

### Automated Tests
- `npm test` — Jest unit tests for protocol encoding/decoding, deviceId generation, state machine transitions
