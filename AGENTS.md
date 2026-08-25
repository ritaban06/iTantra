# AGENTS.md

# iTantra — Offline Multilingual Low-Bandwidth Voice Communication

## 1. Project Overview

iTantra is an Android-first, offline, multilingual emergency communication application designed for environments where Internet connectivity, cellular networks, or conventional communication infrastructure may be unavailable or unreliable.

The system converts speech into text locally, transmits the compact text representation between nearby Android devices, and converts the received text back into speech locally.

The primary communication pipeline is:

    🎤 User Speech
          ↓
    Audio Capture
          ↓
    Voice Activity Detection
          ↓
    Offline STT
          ↓
    Text Processing
          ↓
    Compression / Compact Encoding
          ↓
    Encryption
          ↓
    BLE / Wi-Fi Direct
          ↓
    Decryption
          ↓
    Decompression / Decoding
          ↓
    Offline TTS
          ↓
    🔊 Speech Playback

The complete communication loop must work without Internet connectivity.

---

# 2. SIH Problem Statement

## Problem Statement ID

26173

## Problem Statement Title

iTantra - Indian Multilingual TTS & STT Aided Neural Transceiver Radio Access for low bitrate links

## Target Requirements

The system should support:

- Offline STT
- Offline TTS
- 10 Indian languages
- Low-bandwidth communication
- Android devices
- Bluetooth communication
- Wi-Fi-based peer-to-peer communication
- Phone-to-phone communication
- Push-to-talk communication
- Phone-like conversational communication
- Emergency alerts
- Low latency
- Low CPU usage
- Low RAM usage
- Small model footprint

## Supported Languages

1. Hindi
2. Gujarati
3. Marathi
4. Kannada
5. Malayalam
6. Tamil
7. Telugu
8. Odia
9. Bengali
10. English

---

# 3. Core Architecture

The project uses a hybrid architecture.

    React Native
          │
          │ Native Modules
          ▼
    Kotlin Android Layer
          │
    ┌─────┼──────────┐
    │     │          │
   STT   TTS       Transport
    │     │          │
    │     │      ┌───┴────┐
    │     │     BLE     Wi-Fi
    │     │
    └─────┴──────────────┐
                         │
                    Android APIs

## React Native Responsibilities

React Native is the primary application framework.

React Native handles:

- UI
- Navigation
- Application state
- Chat/message interface
- Push-to-talk interface
- Emergency alert interface
- Language selection
- Device discovery UI
- Connection status
- Settings
- Pairing UI
- Message history
- Performance dashboard
- User preferences

## Kotlin Responsibilities

Kotlin is used only where native Android functionality, performance, or hardware access requires it.

Kotlin handles:

- AudioRecord
- Native audio processing
- Offline STT runtime integration
- Offline TTS runtime integration
- BLE
- Wi-Fi Direct
- Foreground services
- Background communication
- Low-level packet handling
- Native Android APIs
- Performance-critical operations

Do NOT rewrite the entire application in Kotlin.

Do NOT move ordinary UI logic from React Native to Kotlin without a clear reason.

---

# 4. Technology Stack

## Frontend / Application

- React Native
- JavaScript
- React
- React Navigation
- React Native New Architecture where practical

TypeScript is optional.

If the existing project is JavaScript-based, do not migrate the entire project to TypeScript solely for this project.

---

## Android Native Layer

- Kotlin
- Android SDK
- Gradle
- Kotlin Coroutines
- Android Bluetooth APIs
- Wi-Fi Direct APIs
- AudioRecord
- Android foreground services

---

## Machine Learning

Model development and experimentation:

- Python
- PyTorch
- ONNX
- TFLite tooling where appropriate

Mobile inference may use:

- ONNX Runtime
- TensorFlow Lite
- NCNN
- ExecuTorch
- Another suitable open-source mobile inference runtime

The final runtime must be selected using actual performance benchmarks.

---

## Communication

Primary:

- Bluetooth Low Energy

Secondary:

- Wi-Fi Direct

Optional future:

- Phone-to-phone mesh

External hardware is NOT part of the system.

---

## Security

Use authenticated encryption such as:

- AES-256-GCM
- ChaCha20-Poly1305

Never hardcode encryption keys.

---

# 5. Non-Negotiable Requirements

The core communication system MUST:

- Work offline
- Work without cellular Internet
- Work without cloud APIs
- Run STT locally
- Run TTS locally
- Communicate directly between phones
- Avoid mandatory registration
- Avoid mandatory login
- Avoid mandatory Internet authentication
- Avoid external hardware

The following must NOT be required:

- LoRa
- ESP32
- Arduino
- Raspberry Pi
- External RF modules
- SDR
- Cloud servers
- Firebase
- Supabase
- OpenAI APIs
- Google Cloud Speech
- Azure Speech
- AWS Transcribe
- Cloud TTS

---

# 6. No Mandatory Login

The application should not require an account.

On first launch, generate a local device identity.

Example:

    Device ID:
    ITN-A7F3-92KD

Optional local profile:

    Name:
    Rahul

The user must be able to communicate locally without:

- Email
- Password
- OTP
- Phone-number verification
- Cloud authentication

---

# 7. React Native Architecture

Use a clean separation between React Native and native Android functionality.

    React Native UI
          ↓
    JS Service Layer
          ↓
    Native Module Interface
          ↓
    Kotlin
          ↓
    Android APIs / ML / Transport

React Native should never directly implement low-level Bluetooth packet processing or intensive audio processing.

---

# 8. React Native Modules

Create clear native modules.

Suggested modules:

    NativeSTT
    NativeTTS
    NativeBLE
    NativeWifiDirect
    NativeAudio
    NativeDeviceInfo

Example conceptual interface:

    NativeSTT.startListening()

    NativeSTT.stopListening()

    NativeSTT.loadModel(language)

    NativeTTS.speak(text, language)

    NativeTTS.stop()

    NativeBLE.startAdvertising()

    NativeBLE.startScanning()

    NativeBLE.connect(deviceId)

    NativeBLE.send(packet)

    NativeBLE.disconnect()

The exact API may change during implementation.

Keep the interface small and stable.

---

# 9. Native Module Design

Do not expose unnecessary Android internals to JavaScript.

Bad:

    React Native
        ↓
    Every Bluetooth operation
        ↓
    JS

Preferred:

    React Native
        ↓
    connect(device)
        ↓
    Kotlin
        ↓
    Bluetooth implementation

The JavaScript layer should receive high-level events.

Example:

    BLE_CONNECTED
    BLE_DISCONNECTED
    MESSAGE_RECEIVED
    STT_RESULT
    STT_ERROR
    TTS_STARTED
    TTS_FINISHED

---

# 10. React Native New Architecture

Prefer React Native's New Architecture when compatible with the project's dependencies.

Use:

- TurboModules
- JSI where useful
- Native modules for Android-specific capabilities

Avoid unnecessary serialization between JavaScript and native code.

However, do not introduce JSI complexity unless there is a measurable benefit.

---

# 11. UI Architecture

Use React components with clear separation between:

    Screens
    Components
    Hooks
    Services
    State
    Native modules

Suggested structure:

    src/
    ├── screens/
    ├── components/
    ├── navigation/
    ├── hooks/
    ├── services/
    ├── native/
    ├── state/
    ├── protocol/
    ├── utils/
    ├── constants/
    └── types/

The exact structure may evolve.

---

# 12. Audio Architecture

Audio capture must be implemented using native Android APIs.

Primary API:

    AudioRecord

Pipeline:

    Microphone
        ↓
    AudioRecord
        ↓
    Audio preprocessing
        ↓
    VAD
        ↓
    STT

React Native should control the high-level state but should not process raw PCM audio in JavaScript unless specifically required for experimentation.

Avoid sending large raw audio buffers repeatedly across the React Native bridge.

---

# 13. Voice Activity Detection

VAD should detect:

- Speech start
- Speech continuation
- Silence
- Speech end

For push-to-talk:

    PTT pressed
        ↓
    Start audio capture
        ↓
    User speaks
        ↓
    Pause/silence detected
        ↓
    Finalize utterance
        ↓
    STT

Do not run expensive STT inference continuously while the user is silent.

---

# 14. Offline STT

STT must run entirely on-device.

No Internet request is permitted during STT.

Architecture:

    AudioRecord
        ↓
    Audio preprocessing
        ↓
    STT runtime
        ↓
    Transcript
        ↓
    Kotlin
        ↓
    React Native

Possible runtimes:

- ONNX Runtime
- TFLite
- NCNN
- ExecuTorch

Choose based on:

- Accuracy
- RAM
- CPU
- Model size
- Latency
- Battery
- Android compatibility

---

# 15. STT Requirements

STT should optimize for:

- Low WER
- Low latency
- Low RAM
- Low CPU
- Low battery consumption
- Small model size
- Offline operation
- Indian language support
- Short emergency utterances
- Noisy environments

Example:

    "Hume sector 4 me water supply chahiye immediately."

The system should handle realistic Indian speech rather than assuming perfectly standardized language.

---

# 16. STT Confidence

Where possible, determine confidence.

Example:

    Transcript:
    "Send medical help to sector four."

    Confidence:
    0.96

If confidence is low:

    "Speech unclear. Please repeat."

For safety-critical messages, optionally require user confirmation.

Example:

    Detected:
    "Evacuate sector four."

    [SEND] [REPEAT]

Do not silently transmit obviously low-confidence emergency speech.

---

# 17. Multilingual Support

The architecture must support:

- Hindi
- Gujarati
- Marathi
- Kannada
- Malayalam
- Tamil
- Telugu
- Odia
- Bengali
- English

Language selection should work offline.

Do not use an online language detection service.

---

# 18. Code-Switching

The system should eventually support mixed-language speech.

Example:

    "Hume sector 4 me water supply chahiye immediately."

This may contain:

    Hindi + English

Code-switching is an advanced feature.

Do not delay the MVP because perfect code-switching is unavailable.

---

# 19. Offline TTS

TTS must run locally.

Pipeline:

    Received text
        ↓
    Kotlin
        ↓
    Offline TTS runtime
        ↓
    Audio
        ↓
    Android audio output

The React Native layer should control TTS at a high level.

Example:

    NativeTTS.speak(text, language)

Do not send generated audio through JavaScript unless necessary.

---

# 20. TTS Performance

Measure:

- Time to first audio
- RTF
- Total generation time
- RAM
- CPU
- Battery
- Human intelligibility

RTF:

    RTF =
    speech generation time
    ----------------------
    generated speech duration

Lower is generally better.

---

# 21. Phone-to-Phone Communication

The system must support:

    Phone A
       ↓
    BLE
       ↓
    Phone B

and potentially:

    Phone A
       ↓
    Wi-Fi Direct
       ↓
    Phone B

The application should transmit text-derived packets, not raw speech audio.

---

# 22. BLE

BLE should be the primary low-bandwidth transport for the MVP.

Do NOT continuously stream raw PCM audio over BLE.

Instead:

    Speech
      ↓
    STT
      ↓
    Text
      ↓
    Compact packet
      ↓
    BLE

This is the central concept of the project.

---

# 23. Wi-Fi Direct

Wi-Fi Direct may be used when:

- Higher bandwidth is available
- BLE becomes inefficient
- Larger messages need to be transmitted
- Faster peer-to-peer communication is useful

Keep transport selection separate from the message layer.

---

# 24. Transport Abstraction

Create a common transport interface.

Conceptually:

    Transport

        connect()
        disconnect()
        send(packet)
        receive()
        getStatus()

Implementations:

    BLETransport
    WifiDirectTransport

The rest of the application should not care which transport is being used.

---

# 25. Low-Bandwidth Protocol

Do not use verbose JSON packets for production communication.

Use a compact binary protocol.

Conceptual packet:

    ┌─────────┬──────┬──────┬──────┬────────────┐
    │ Version │ Type │ Lang │ Seq  │ Payload    │
    └─────────┴──────┴──────┴──────┴────────────┘

Additional fields may include:

- Message ID
- Sender ID
- Destination ID
- Priority
- TTL
- Fragment number
- Total fragments
- Payload length
- Authentication tag

---

# 26. Message Types

At minimum:

    NORMAL
    IMPORTANT
    ALERT
    ACK
    NACK
    SYSTEM
    ERROR

Example:

    NORMAL:
    "Where are you?"

    ALERT:
    "Flood water entering shelter three."

ALERT messages have higher priority.

---

# 27. Compression

Transmission pipeline:

    Text
      ↓
    Compact encoding
      ↓
    Compression
      ↓
    Encryption
      ↓
    Packetization
      ↓
    BLE/Wi-Fi

Do not compress encrypted data.

Correct:

    encrypt(compress(data))

Not:

    compress(encrypt(data))

For very short messages, compression may actually increase size.

Measure before enabling compression universally.

---

# 28. Encryption

All application messages must use authenticated encryption.

Preferred:

- AES-256-GCM
- ChaCha20-Poly1305

Pipeline:

    Text
      ↓
    Encoding
      ↓
    Compression
      ↓
    Encryption
      ↓
    Packet
      ↓
    Transport

Receiver:

    Packet
      ↓
    Decryption
      ↓
    Decompression
      ↓
    Text
      ↓
    TTS

---

# 29. Key Management

Never use:

    "secret123"

or any hardcoded universal key.

Use secure pairing.

Possible MVP options:

- QR-code pairing
- Numeric verification code
- Public-key exchange
- Local device pairing

Cryptographic keys should be protected using Android security mechanisms where appropriate.

---

# 30. Packet Reliability

BLE/Wi-Fi connectivity may be interrupted.

Implement:

- Sequence numbers
- ACK
- NACK
- Retransmission
- Duplicate detection
- Fragmentation
- Reassembly
- Message expiry
- TTL

Example:

    Packet 001 → ACK
    Packet 002 → ACK
    Packet 003 → LOST
    Retransmit 003 → ACK

Never claim successful delivery without appropriate acknowledgement.

---

# 31. Fragmentation

Large messages must be fragmented.

Example:

    Message
       ↓
    Fragment 1
    Fragment 2
    Fragment 3
       ↓
    Transport
       ↓
    Reassembly
       ↓
    Complete message

Each fragment must contain enough metadata to identify:

- Message ID
- Fragment index
- Total fragments

Incomplete emergency messages must never be treated as complete.

---

# 32. Emergency Alerts

ALERT messages receive higher priority.

Example:

    "EVACUATE SHELTER THREE IMMEDIATELY."

The receiver should:

1. Display a prominent alert.
2. Prioritize transmission/playback.
3. Play using an appropriate high-volume mechanism.
4. Support repetition.
5. Support acknowledgement.
6. Distinguish ALERT from NORMAL messages.

Do not attempt to bypass Android OS security or volume restrictions.

---

# 33. Emergency Safety

The system must preserve safety-critical information.

Never intentionally remove:

- Negations
- Numbers
- Locations
- Names
- Directions
- Medical information
- Emergency commands

Example:

    "Do NOT enter sector 4."

must never become:

    "Enter sector 4."

Accuracy is more important than extreme compression for safety-critical content.

---

# 34. Speaker Cloning

Speaker cloning is NOT part of the MVP.

Baseline:

    Speech
      ↓
    STT
      ↓
    Text
      ↓
    TTS

Do not transmit:

- Speaker embeddings
- Voiceprints
- Voice cloning models

unless a later research milestone explicitly requires them.

Reasons:

- Increased bandwidth
- Increased compute
- Privacy concerns
- Security risks
- Added complexity

---

# 35. Privacy

Minimize persistent storage.

Avoid permanently storing:

- Raw microphone recordings
- Sensitive transcripts
- Emergency messages
- Speaker embeddings
- Cryptographic keys in insecure storage

Temporary buffers should be cleared when no longer required.

Production logs must not contain raw user speech or emergency transcripts.

---

# 36. No Cloud

The core pipeline must not depend on:

- Internet
- Cloud STT
- Cloud TTS
- Remote inference
- Cloud authentication
- Firebase
- Supabase
- External APIs

The core communication loop should function with Internet connectivity unavailable.

---

# 37. Background Communication

If background communication is required, use Android-supported mechanisms.

Possible mechanisms:

- Foreground Service
- Bluetooth APIs
- Coroutines
- Appropriate Android background APIs

Do not attempt to bypass Android background restrictions.

Avoid infinite polling loops.

---

# 38. Battery Optimization

Emergency devices may need to operate for long periods.

Optimize:

- BLE scanning
- BLE advertising
- CPU usage
- STT activation
- TTS model loading
- Background processing
- Wake locks

Avoid running expensive ML models while idle.

---

# 39. Model Loading

Do not automatically load every language model into RAM.

Prefer:

    Selected language
        ↓
    Load model
        ↓
    Process
        ↓
    Cache/unload according to memory constraints

Benchmark multilingual models versus language-specific models.

---

# 40. State Management

React Native should maintain high-level application state.

Example:

    IDLE
    CONNECTING
    CONNECTED
    LISTENING
    PROCESSING_STT
    ENCODING
    ENCRYPTING
    TRANSMITTING
    WAITING_ACK
    RECEIVING
    DECODING
    PROCESSING_TTS
    PLAYING
    ERROR

Native modules should emit state/events to React Native.

---

# 41. Error Handling

Explicitly handle:

    STT_FAILED
    STT_LOW_CONFIDENCE
    TTS_FAILED
    BLE_UNAVAILABLE
    BLE_DISCONNECTED
    WIFI_UNAVAILABLE
    PACKET_CORRUPTED
    DECRYPTION_FAILED
    INVALID_PACKET
    MESSAGE_EXPIRED
    MESSAGE_DUPLICATE
    OUT_OF_ORDER_PACKET
    MODEL_NOT_FOUND
    INSUFFICIENT_MEMORY

Do not silently ignore errors.

---

# 42. Logging

Development logs may include:

- Packet IDs
- Latency
- CPU usage
- RAM usage
- Model performance
- Connection state
- Packet loss

Production logs MUST NOT include:

- Raw audio
- Full emergency transcripts
- Encryption keys
- Sensitive user data

---

# 43. Performance Metrics

Measure the complete pipeline:

    Speech begins
        ↓
    STT completed
        ↓
    Encoding
        ↓
    Encryption
        ↓
    Transmission
        ↓
    Reception
        ↓
    Decryption
        ↓
    Decoding
        ↓
    TTS
        ↓
    Audio playback begins

Record:

    End-to-End Latency

Also measure:

### STT

- WER
- CER
- Median latency
- P95 latency
- RAM
- CPU
- Model size
- Battery
- RTF

### TTS

- Time-to-first-audio
- RTF
- RAM
- CPU
- Model size
- Battery
- Human intelligibility

### Network

- Bytes/message
- Bits/message
- Packet count
- Packet loss
- Retransmission rate
- End-to-end latency
- Delivery success
- Hop count

### Application

- APK size
- Model footprint
- Startup time
- Idle RAM
- Active RAM

---

# 44. Latency Strategy

Investigate:

- Streaming STT
- Partial transcription
- Voice activity detection
- Endpoint detection
- Incremental processing
- Sentence segmentation

However:

    Accuracy > premature transmission

Do not send incomplete text if it could change the meaning of an emergency message.

---

# 45. MVP Strategy

Do not attempt all ten languages immediately.

Start with:

    English
    Hindi
    Bengali

First prove:

    Phone A
       ↓
    Offline STT
       ↓
    Text
       ↓
    Compression
       ↓
    Encryption
       ↓
    BLE
       ↓
    Decryption
       ↓
    Decompression
       ↓
    Offline TTS
       ↓
    Phone B

After this works reliably, add the remaining languages.

---

# 46. Development Milestones

## Milestone 1 — React Native UI

Build:

- Home screen
- PTT button
- Message screen
- Connection screen
- Language selector
- Emergency alert screen

Use mock data initially.

---

## Milestone 2 — Offline STT

Implement:

    Microphone
        ↓
    Kotlin
        ↓
    Offline STT
        ↓
    React Native

Start with one language.

---

## Milestone 3 — Offline TTS

Implement:

    React Native
        ↓
    Kotlin
        ↓
    Offline TTS
        ↓
    Speaker

---

## Milestone 4 — Local Speech Loop

Implement:

    Speech
      ↓
    STT
      ↓
    Text
      ↓
    TTS
      ↓
    Speech

No networking yet.

---

## Milestone 5 — BLE

Implement:

    Phone A
       ↓
      BLE
       ↓
    Phone B

Initially send:

    HELLO

Then send actual text.

---

## Milestone 6 — Protocol

Implement:

- Binary packets
- Message ID
- Sequence numbers
- Language
- Message type
- Payload
- ACK/NACK

---

## Milestone 7 — Encryption

Implement:

    Compression
        ↓
    Encryption
        ↓
    BLE

Test authentication failures.

---

## Milestone 8 — Reliability

Implement:

- Retransmission
- Fragmentation
- Reassembly
- Deduplication
- TTL
- Expiration

---

## Milestone 9 — Wi-Fi Direct

Add Wi-Fi Direct as an additional transport.

Do not rewrite the message layer.

---

## Milestone 10 — Mesh

Optional:

    Phone A
       ↓
    Phone B
       ↓
    Phone C

Implement:

- TTL
- Duplicate detection
- Forwarding
- Store-and-forward

---

## Milestone 11 — All Languages

Add:

- Gujarati
- Marathi
- Kannada
- Malayalam
- Tamil
- Telugu
- Odia

along with:

- Hindi
- Bengali
- English

Benchmark each language.

---

# 47. Repository Structure

Recommended:

    itantra/
    │
    ├── android/
    │   └── app/
    │       └── src/main/
    │           └── java/com/itantra/
    │               ├── audio/
    │               ├── stt/
    │               ├── tts/
    │               ├── ble/
    │               ├── wifi/
    │               ├── transport/
    │               ├── protocol/
    │               ├── crypto/
    │               ├── compression/
    │               ├── mesh/
    │               └── service/
    │
    ├── src/
    │   ├── screens/
    │   ├── components/
    │   ├── navigation/
    │   ├── hooks/
    │   ├── services/
    │   ├── native/
    │   ├── state/
    │   ├── protocol/
    │   ├── utils/
    │   └── constants/
    │
    ├── models/
    │   ├── stt/
    │   └── tts/
    │
    ├── tools/
    │   ├── benchmark/
    │   ├── conversion/
    │   └── dataset/
    │
    ├── docs/
    │   ├── architecture/
    │   ├── protocol/
    │   ├── security/
    │   └── benchmarks/
    │
    ├── tests/
    ├── package.json
    ├── android/
    └── AGENTS.md

The exact structure may change during implementation.

---

# 48. JavaScript Rules

React Native JavaScript should handle:

- UI
- Application state
- User interactions
- Navigation
- High-level service calls

Avoid:

- Raw PCM processing
- Intensive ML computation
- Continuous BLE packet parsing
- Cryptographic loops
- Large binary transformations

in JavaScript when the operation can efficiently be performed natively.

---

# 49. Kotlin Rules

Kotlin should handle:

- Android-specific functionality
- Audio capture
- ML inference
- BLE
- Wi-Fi Direct
- Background services
- Performance-critical processing

Kotlin code should expose a clean API to React Native.

Avoid exposing large implementation details to JavaScript.

---

# 50. Communication Service

React Native should interact with one high-level communication service.

Conceptually:

    CommunicationService

        discoverDevices()
        connect(device)
        disconnect()
        sendMessage(message)
        sendAlert(message)
        getConnectionStatus()

Internally:

    CommunicationService
          ↓
    TransportManager
          ↓
    BLETransport / WifiTransport

This keeps the UI independent from the actual networking implementation.

---

# 51. Transport Selection

The application may select transport dynamically.

Example:

    BLE available
        ↓
    Use BLE

    Wi-Fi Direct preferred/available
        ↓
    Use Wi-Fi Direct

The decision must be made by the transport layer.

React Native UI should not contain low-level transport selection logic.

---

# 52. Testing

## Unit Tests

Test:

- Packet encoding
- Packet decoding
- Compression
- Encryption
- Decryption
- Sequence numbers
- Fragmentation
- Reassembly
- TTL
- Message priority

## Native Tests

Test:

- Audio capture
- STT
- TTS
- BLE
- Wi-Fi Direct

## React Native Tests

Test:

- UI state
- Message state
- Connection state
- Error handling
- Navigation

## Integration Tests

Test:

    React Native
        ↓
    Kotlin
        ↓
    STT
        ↓
    Protocol
        ↓
    Encryption
        ↓
    BLE
        ↓
    Decryption
        ↓
    TTS
        ↓
    React Native

---

# 53. Network Failure Testing

Simulate:

- Packet loss
- Packet duplication
- Packet reordering
- High latency
- BLE disconnect
- Device disappearance
- Small MTU
- Low bandwidth

The system should recover gracefully.

---

# 54. Audio Testing

Test under:

- Quiet room
- Traffic
- Crowd noise
- Wind
- Sirens
- Construction
- Vehicle engine
- Radio-like noise

Do not benchmark only in a silent room.

---

# 55. Security Testing

Test:

- Invalid packets
- Modified packets
- Invalid authentication tags
- Replay attempts
- Duplicate messages
- Expired messages
- Unauthorized devices
- Key exchange
- Malformed packets

BLE security alone must not be treated as sufficient application-level security.

---

# 56. Battery Optimization

The application should minimize:

- BLE scanning
- BLE advertising
- CPU usage
- STT activity during silence
- TTS activity while idle
- Background wakeups

Prefer event-driven architecture.

---

# 57. Android Permissions

Request only permissions actually required by the selected Android APIs.

Permission requests should:

- Be explained clearly
- Be requested at the appropriate time
- Handle denial gracefully
- Avoid unnecessary permissions

Do not request Internet permission as a requirement for the core communication system.

---

# 58. No External Hardware

The SIH demonstration MUST NOT require:

- LoRa
- ESP32
- Arduino
- Raspberry Pi
- RF modules
- SDR
- USB radio hardware

The demonstration should use only Android phones.

Communication:

    Phone
      ↕
    Phone

using:

- BLE
- Wi-Fi Direct
- Other native phone-to-phone connectivity where appropriate

---

# 59. Demo Scenario

Simulate a disaster environment.

Phone A:

    "Two people are injured at shelter number three.
     Send medical assistance immediately."

Pipeline:

    🎤 Speech
        ↓
    Offline STT
        ↓
    Text
        ↓
    Compact encoding
        ↓
    Encryption
        ↓
    BLE
        ↓
    Decryption
        ↓
    Decoding
        ↓
    Offline TTS
        ↓
    🔊 Phone B

The demo must visibly demonstrate:

- Internet OFF
- No cloud API
- Two Android phones
- Offline STT
- Compact payload
- Encrypted transmission
- Offline TTS
- End-to-end latency
- Payload size

---

# 60. Benchmark Dashboard

Create a development/debug screen showing real measurements.

Example:

    ┌─────────────────────────────────────┐
    │ iTantra Performance                 │
    ├─────────────────────────────────────┤
    │ Language: Bengali                   │
    │ STT Latency: 420 ms                 │
    │ TTS RTF: 0.31                       │
    │ Payload: 84 bytes                   │
    │ Packets: 2                          │
    │ E2E Latency: 1.12 sec               │
    │ RAM: 410 MB                         │
    │ CPU: 32%                            │
    └─────────────────────────────────────┘

All values must be measured dynamically.

Never hardcode benchmark results.

---

# 61. MVP Definition

The MVP is complete when two Android phones can perform:

    Phone A

    🎤 Speak
       ↓
    Offline STT
       ↓
    Text
       ↓
    Compress
       ↓
    Encrypt
       ↓
    BLE
       ↓

    Phone B

       ↓
    Decrypt
       ↓
    Decompress
       ↓
    Text
       ↓
    Offline TTS
       ↓
    🔊 Hear

without:

- Internet
- Cloud services
- Cellular data
- User accounts
- External hardware

---

# 62. Features to Delay

Do NOT build these first:

- Login
- Registration
- Cloud backend
- Web dashboard
- Firebase
- Online STT
- Online TTS
- Voice cloning
- Speaker identification
- LoRa
- ESP32
- External radio hardware
- Social features
- Complex contact systems

First prove the fundamental communication loop.

---

# 63. Advanced Features

After the MVP works:

- BLE mesh
- Store-and-forward
- Adaptive compression
- Semantic compression
- Streaming STT
- Code-switching
- Automatic language detection
- Emergency routing
- Message priority
- Expressive TTS
- Multi-hop communication

Advanced features must not compromise the basic reliable communication loop.

---

# 64. Development Priority

Always prioritize:

    Emergency Safety
          >
    Reliability
          >
    Offline Operation
          >
    STT/TTS Accuracy
          >
    End-to-End Latency
          >
    Bandwidth Efficiency
          >
    Battery Efficiency
          >
    Feature Richness

---

# 65. Agent Instructions

When modifying this project:

1. Read this AGENTS.md before making architectural changes.
2. React Native is the primary application framework.
3. Use Kotlin only for Android-native capabilities.
4. Do not migrate the entire application to Kotlin.
5. Do not introduce React Native dependencies that require Internet connectivity for core communication.
6. Do not introduce cloud STT/TTS.
7. Do not introduce mandatory login or registration.
8. Do not introduce external hardware.
9. Do not introduce LoRa or ESP32.
10. Keep BLE and Wi-Fi behind a transport abstraction.
11. Keep STT/TTS independent from the UI.
12. Do not send large raw audio buffers through JavaScript unnecessarily.
13. Keep performance-critical work native.
14. Keep React Native responsible for UI and high-level state.
15. Benchmark model changes.
16. Measure actual end-to-end latency.
17. Measure actual transmitted bytes.
18. Measure RAM and CPU usage.
19. Never hardcode cryptographic keys.
20. Never log sensitive transcripts in production.
21. Never claim delivery without appropriate acknowledgement.
22. Preserve safety-critical words and information.
23. Test on low and mid-range Android devices.
24. Test with Internet disabled.
25. Document major architectural decisions.
26. Prefer simple, reliable implementations over unnecessary complexity.
27. Do not implement advanced research features before the MVP is stable.
28. Never sacrifice emergency-message correctness purely to reduce packet size.

The project is an offline emergency communication system,
not a conventional Internet chat application.