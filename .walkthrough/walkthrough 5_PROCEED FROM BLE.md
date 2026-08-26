# iTantra — Proceed From BLE

## Purpose

This file is the persistent project handoff/context document for continuing
development of iTantra from the completed BLE + semantic communication
implementation into the AI speech-processing stages.

It is intended to help future agents and collaborators understand:

- what has already been built
- the current architecture
- important architectural decisions
- completed Git checkpoints
- current V5A findings
- what must be implemented next
- what must NOT be redesigned unnecessarily

The live repository/source code is always authoritative if this document
ever differs from the actual implementation.

---

# 1. CURRENT GIT CHECKPOINT

## Branch

feature/ble-transport-v1




## Current branch history


1020735  V4 — Semantic Message Layer
57e9690  V3 — Speech → BLE → Speech
ccb8fd9  V2 — BLE GATT Transport + HELLO
313bcc8  React Native dependency alignment
7aedfb9  Existing STT model/UI checkpoint

The working tree was clean after the V4 checkpoint.

2. PROJECT GOAL

The final goal is an offline, on-device AI communication system using
Bluetooth/BLE mesh transport.

Core concept:

Sender Phone

Microphone
   ↓
Noise suppression
   ↓
Speech recognition
   ↓
AI semantic analysis
   ↓
Compact semantic message
   ↓
Encrypted mesh transport
   ↓
Receiver Phone
   ↓
Semantic reconstruction
   ↓
On-device TTS
   ↓
Speaker

The system must work without:

cellular network
Internet
cloud AI
cloud speech APIs

The long-term communication concept is:

Communicate semantic information rather than transmitting the complete
original audio waveform whenever bandwidth is constrained.

3. COMPLETED FOUNDATION
M1 — Existing UI

Completed before this BLE branch.

React Native UI and navigation already existed.

M2 — Offline STT

Completed.

Existing native Android STT infrastructure includes:

STTModule.kt
AudioCaptureManager.kt
VoiceActivityDetector.kt
VoskSTTEngine.kt
IndicConformerSTTEngine.kt

The application already supports offline STT.

M3 — Offline TTS

Completed.

Existing Android TTS infrastructure is already integrated and used by the
local speech loop.

Do not create another TTS engine unless a future milestone explicitly
requires a replacement.

M4 — Local Speech Loop

Completed.

Existing local PTT flow:

PTT
 ↓
LocalLoopService
 ↓
STT
 ↓
local TTS

The existing local speech loop includes microphone mute/unmute behavior for
echo prevention.

4. BLE V1 — DISCOVERY

Completed in code.

Capabilities:

BLE advertising
BLE scanning
iTantra service UUID
device ID
Android BLE permissions
React Native ↔ Kotlin BLE bridge
discovery UI

Service UUID:

12345678-1234-1234-1234-123456789ABC

Device ID format:

ITN-XXXX-XXXX

The device ID is persisted locally and is not derived from the Bluetooth MAC
address.

Important V1 implementation decisions:

BLE transport lives in Kotlin/native Android code.
React Native accesses BLE through a native module.
BLE discovery is separated from the speech/semantic layers.
BLE transport must remain generic.
5. BLE V2 — GATT TRANSPORT

Completed in code.

Files include:

android/app/src/main/java/com/itantra/ble/
├── BLEConstants.kt
├── BLEAdvertiser.kt
├── BLEScanner.kt
├── BLEGattServer.kt
├── BLEGattClient.kt
├── BLEConnectionManager.kt
├── BLEModule.kt
└── BLEPackage.kt

GATT service:

12345678-1234-1234-1234-123456789ABC

Characteristics:

TX:
12345678-1234-1234-1234-123456789ABD

RX:
12345678-1234-1234-1234-123456789ABE

CCCD:
00002902-0000-1000-8000-00805f9b34fb

Both phones are architecturally capable of acting as both:

GATT server
GATT client

The V2 test path was:

Phone A
 ↓
discover Phone B
 ↓
GATT connect
 ↓
send "HELLO"
 ↓
Phone B receives "HELLO"

Bidirectional transport was implemented in code.

6. BLE V3 — SPEECH → BLE → SPEECH

Completed in code.

Target flow:

PHONE A

Microphone
   ↓
Existing STT
   ↓
Final transcript
   ↓
BLE
   ↓
PHONE B
   ↓
Existing TTS
   ↓
Speaker

BLE Voice Mode was introduced.

Important behavior:

Normal mode
PTT
 ↓
LocalLoopService
 ↓
STT
 ↓
local TTS
BLE Voice Mode
PTT
 ↓
Direct NativeSTT
 ↓
STT_RESULT
 ↓
BLE send

Incoming BLE speech:

BLE receive
 ↓
decode
 ↓
mute microphone
 ↓
existing TTS
 ↓
unmute microphone

The local TTS duplication issue was fixed by bypassing
LocalLoopService when BLE Voice Mode is enabled.

The stale onFinalResultIntercept was also cleared on local-loop stop.

The generic useBLE() cleanup no longer unconditionally disconnects GATT,
because multiple screens may use BLE state.

7. V4 — SEMANTIC MESSAGE LAYER

Completed in code.

Current semantic architecture:

STT
 ↓
SemanticMessage
 ↓
Codec
 ↓
BLE
 ↓
Codec
 ↓
SemanticMessage
 ↓
TTS

Current schema:

{
  "version": 1,
  "messageId": "msg_<timestamp-base36>_<random-hex>_<counter>",
  "text": "Hello judges",
  "language": "en",
  "emotion": "neutral",
  "emotionConfidence": 0.0,
  "voiceProfile": "default"
}

Supported emotions currently defined:

neutral
happy
sad
angry

Current V4 defaults:

emotion = neutral
emotionConfidence = 0.0
voiceProfile = default

Current codec is JSON.

The BLE transport remains generic and does not know the meaning of the
semantic fields.

This separation must be preserved.

8. CURRENT HIGH-LEVEL ARCHITECTURE
                    PHONE A

                   🎤 MIC
                     │
                     ▼
              AudioRecord
                     │
                     ▼
              Audio Pipeline
                     │
                     ▼
                    STT
                     │
                     ▼
             SemanticMessage
                     │
                     ▼
              BLE GATT / Mesh
                     │
          ───────────┼───────────
                     │
                     ▼
             SemanticMessage
                     │
                     ▼
                   TTS
                     │
                     ▼
                  🔊 SPEAKER

The future AI enhancement stage must be inserted before STT.

9. V5A — DEEPFILTERNET AUDIT STATUS

V5A is NOT implemented yet.

V5A was a read-only feasibility and architecture audit.

No V5A source files were modified.

No V5A Git operations were performed.

The audit established the following.

10. V5A QUESTION 1 — EXACT DEEPFILTERNET INSERTION POINT

Recommended insertion point:

File:
android/app/src/main/java/com/itantra/stt/STTModule.kt

Class:
STTModule

Method:
startListening()

Specific location:
the `onChunk` lambda passed to AudioCaptureManager

Current flow:

AudioCaptureManager.onChunk(ByteArray[4096])
                │
                ▼
             STTModule
                │
                ├── ByteArray → ShortArray
                │
                ├── VAD
                │
                └── STT engine

Current chunk handling:

ByteArray[4096]
        ↓
ShortArray[2048]
        ↓
VAD

ByteArray[4096]
        ↓
STT engine

Recommended future insertion:

AudioRecord
   ↓
ByteArray[4096]
   ↓
ByteArray → ShortArray
   ↓
DeepFilterEngine.process(...)
   ↓
filtered ShortArray
   ├────────→ VAD
   │
   └────────→ filtered ByteArray
                  ↓
                 STT

The audit considers this the safest insertion point because:

all captured speech reaches this callback
filtering occurs before both VAD and STT
raw PCM is still available
AudioCaptureManager does not need to be redesigned
existing microphone mute behavior remains intact
BLE/local mode branching remains downstream

The audit specifically rejected placing DeepFilterNet:

inside AudioCaptureManager
inside VAD
separately inside each STT engine
as an unnecessary capture wrapper

because those approaches would mix responsibilities or require duplication.

11. V5A QUESTION 2 — ACTUAL CURRENT AUDIO FORMAT

Current iTantra audio format:

Sample rate:
16,000 Hz

Channels:
Mono

PCM:
16-bit signed PCM

Byte order:
Little-endian

Capture representation:
ByteArray

VAD representation:
ShortArray

STT representation:
ByteArray

Current read buffer:

4096 bytes

Therefore:

4096 bytes
÷ 2 bytes/sample
=
2048 samples

At 16 kHz:

2048 / 16000
=
128 ms per chunk

Current flow:

AudioRecord.read(ByteArray[4096])
        ↓
AudioCaptureManager.onChunk(ByteArray[4096])
        ↓
STTModule.onChunk
        │
        ├── ByteArray
        │      ↓
        │   ShortArray[2048]
        │      ↓
        │   VAD
        │
        └── ByteArray[4096]
               ↓
           STT engine

Vosk receives raw PCM bytes.

IndicConformer receives raw PCM bytes and internally performs:

ByteArray
 ↓
ShortArray
 ↓
Float
 ↓
pre-emphasis
 ↓
FFT
 ↓
Hann window
 ↓
Mel filterbank
 ↓
log compression
 ↓
normalization
 ↓
ONNX inference

Important finding:

AudioPreprocessor.kt is NOT the general microphone preprocessing stage.

It is used inside IndicConformer for STT feature extraction.

Therefore DeepFilterNet should NOT be inserted into AudioPreprocessor.

The intended future order is:

AudioRecord
 ↓
DeepFilterNet
 ↓
VAD
 ↓
STT

with IndicConformer feature extraction remaining internal to its STT engine.

12. V5A QUESTION 3 — ONNX VS NATIVE RUST
Recommendation

Use ONNX Runtime Android.

Reason:

The repository already contains:

com.microsoft.onnxruntime:onnxruntime-android:1.17.3

and the existing IndicConformerSTTEngine.kt already demonstrates:

OrtEnvironment
 ↓
OrtSession
 ↓
OnnxTensor
 ↓
session.run()

Therefore ONNX Runtime is already a proven inference architecture inside
this exact repository.

ONNX Runtime

Advantages:

already present
no new Rust toolchain
no new Cargo build
no new CMake system
no custom JNI bridge
existing ONNX inference example in repository
compatible with the intended mobile deployment
lower implementation risk
Native Rust/JNI

Not recommended for this project at this stage.

The repository has:

no Rust infrastructure
no Cargo project
no JNI Rust bridge
no CMake integration for this purpose
no established Rust/mobile-native build pattern

Using Rust would therefore introduce an entirely new build/runtime ecosystem.

Third option

TFLite/ExecuTorch is not currently preferred because there is no existing
infrastructure and the audited DeepFilterNet deployment does not provide the
same compatibility path.

13. V5A QUESTION 4 — STREAMING STATE

DeepFilterNet must be treated as a stateful streaming processor.

State includes:

temporal model state
overlap/context buffers
frame alignment
potentially recurrent hidden states
model-specific state tensors

Do NOT process each AudioRecord chunk as an unrelated independent clip.

Recommended architecture:

DeepFilterEngine
    │
    ├── ONNX session
    ├── model state
    ├── overlap buffer
    └── frame state

Suggested API:

class DeepFilterEngine {
    fun load()
    fun process(pcm: ShortArray): ShortArray
    fun reset()
    fun release()
}

Lifecycle:

PTT starts
   ↓
reset/load
   ↓
audio chunks
   ↓
process sequentially
   ↓
state preserved between chunks
   ↓
PTT stops
   ↓
flush/reset

Important state rules:

New utterance

Reset state.

PTT interrupted

Reset state.

BLE mode changes

No DeepFilter reset is required merely because BLE/local mode changes,
because filtering belongs before mode branching.

Inference failure

Bypass filtering and continue with raw PCM.

App backgrounded

Reset before the next active utterance.

Language changes

DeepFilterNet is language-agnostic, so no model-language switch is needed,
but state should be reset for a clean new utterance.

14. V5A QUESTION 5 — EXACT FUTURE FILE CHANGES
Files to CREATE
android/app/src/main/java/com/itantra/audio/DeepFilterEngine.kt

Responsibility:

load ONNX model
maintain inference state
process streaming PCM
manage overlap/frame state
reset
release
expose fallback/error state
android/app/src/main/java/com/itantra/audio/DeepFilterConfig.kt

Responsibility:

model path
frame configuration
overlap configuration
enable/disable state
other DeepFilter configuration
Files to MODIFY
android/app/src/main/java/com/itantra/stt/STTModule.kt

Responsibilities:

create/use DeepFilterEngine
reset it when speech capture begins
process each audio chunk
pass filtered audio to VAD/STT
release/cleanup engine resources
Files NOT expected to change
AudioCaptureManager.kt
AudioPreprocessor.kt
VoiceActivityDetector.kt
VoskSTTEngine.kt
IndicConformerSTTEngine.kt

BLEModule.kt
BLEGattClient.kt
BLEGattServer.kt

NativeSTT.js
NativeBLE.ts
usePTT.ts
useBLEVoiceMode.ts

ConnectScreen.tsx
HomeScreen.tsx

SemanticMessageTypes.ts
SemanticMessageCodec.ts

The goal is to keep DeepFilterNet completely inside the shared native audio/STT
processing boundary.

15. V5A AUDIO COMPATIBILITY

Current iTantra:

16 kHz
mono
16-bit signed PCM
ShortArray / ByteArray

DeepFilterNet deployment being considered:

16 kHz mode
mono
floating-point tensor input/output
streaming state
fixed frame processing

Therefore conversion is required.

Proposed future conversion:

ByteArray
 ↓
ShortArray
 ↓
FloatArray
    (Short / 32768.0)
 ↓
DeepFilterNet
 ↓
FloatArray
 ↓
ShortArray
    (×32768 + clamp)
 ↓
ByteArray
    (little-endian)
 ↓
VAD + STT

Framing/overlap processing is also required according to the selected model
export and its exact input/output tensor contract.

IMPORTANT:

Do not assume the precise frame/overlap numbers from this document without
verifying the actual DeepFilterNet model export that we choose.

16. V5A LATENCY / PERFORMANCE PLAN

The current capture chunk is approximately:

128 ms

Therefore DeepFilterNet inference must fit comfortably inside the available
real-time budget.

The audit identified these future instrumentation points:

t_capture
t_filter_start
t_filter_end
t_vad
t_stt_final
t_semantic_encode
t_ble_send
t_ble_receive
t_tts_start
t_tts_end

The most useful judge-facing metric should be:

PTT release
        ↓
remote phone first TTS audio

This demonstrates the complete offline communication chain.

Actual DeepFilterNet latency, RAM, thermal behavior, and end-to-end latency
must be measured on physical Android devices.

17. V5A MODEL PACKAGING PLAN

The existing repository uses two relevant model patterns:

Vosk

Bundled in APK assets.

IndicConformer

Downloaded to local application storage.

For the competition demo, the recommended approach is:

Bundle DeepFilterNet model in APK assets.

Proposed location:

android/app/src/main/assets/models/audio/deepfilternet3.onnx

Reason:

no first-run network dependency
guaranteed offline operation
simple deployment
model is relatively small compared with the rest of the system
follows the existing Vosk asset pattern

This decision should be revisited if the final selected model/export is much
larger or if future model updates are required.

18. V5A FAILURE / FALLBACK PLAN

DeepFilterNet must be a transparent enhancement layer.

Desired fallback:

DeepFilterNet available
        ↓
filtered audio
        ↓
VAD
        ↓
STT

If unavailable or broken:

DeepFilterNet unavailable
        ↓
raw audio
        ↓
VAD
        ↓
STT

Failure cases:

model missing
corrupted model
ONNX Runtime initialization failure
inference exception
unsupported device
memory pressure
excessive latency

The existing speech system must continue functioning without DeepFilterNet.

19. V5A TEST PLAN

Future DeepFilterNet tests should include:

filter disabled → raw PCM unchanged
filter enabled → correct output format
output length matches expected input length
sequential chunks preserve state
reset clears state
release frees model/runtime resources
missing model → fallback
inference error → fallback
no chunk loss
no duplicate chunks
no audible discontinuity at chunk boundaries
PTT restart resets model state
no network request occurs during inference
normal local PTT continues working
BLE Voice Mode continues working
incoming BLE feedback prevention continues working
20. V5A RISKS

Current identified risks:

DeepFilterNet ONNX model/export

The exact model export and tensor contract must be verified before implementation.

Audio format/framing

The existing app uses 16 kHz / 128 ms capture chunks while the selected
DeepFilterNet model may require different internal frame sizes and overlap.

Do not hard-code model-specific frame assumptions until the exact model is
verified.

ONNX state handling

Depending on the selected export, recurrent/state tensors may need to be
managed explicitly.

Low-memory devices

Running:

ONNX Runtime
+
DeepFilterNet
+
STT

may be more demanding on low-RAM phones.

Thermal behavior

Long continuous speech sessions must be tested on physical phones.

First-utterance latency

Model initialization may add startup cost.

A future implementation should support model warm-up at app launch if
measurements show this is beneficial.

21. V5A IMPLEMENTATION ORDER

Do NOT implement the entire V5A stack at once.

Recommended order:

Step 1

Obtain and verify the exact DeepFilterNet ONNX model/export.

Verify:

model file
input tensor names
output tensor names
tensor shapes
sample-rate mode
state tensors
frame requirements
overlap requirements
Step 2

Create:

DeepFilterConfig.kt
Step 3

Create:

DeepFilterEngine.kt

Following the established ONNX Runtime pattern already used by
IndicConformerSTTEngine.kt.

Step 4

Unit-test the engine independently.

Do not initially connect it to live microphone capture.

Step 5

Integrate it into:

STTModule.startListening()

at the onChunk processing point.

Step 6

Verify:

raw audio
→ DeepFilter
→ VAD
→ Vosk
Step 7

Verify IndicConformer still works.

Step 8

Verify normal local PTT still works.

Step 9

Verify BLE Voice Mode still works.

Step 10

Measure latency and resource usage on physical devices.

22. IMPORTANT ARCHITECTURAL RULES GOING FORWARD

Do not put DeepFilterNet logic into:

AudioCaptureManager
AudioPreprocessor
VoiceActivityDetector
VoskSTTEngine
IndicConformerSTTEngine
BLEModule
BLEGattClient
BLEGattServer
SemanticMessageCodec

Keep it as a dedicated audio enhancement component.

The desired architecture is:

AudioRecord
   ↓
DeepFilterEngine
   ↓
VAD
   ↓
STT
   ↓
SemanticMessage
   ↓
BLE
   ↓
TTS
23. NEXT MAJOR AI ROADMAP

After DeepFilterNet is stable:

V5B — Speech Emotion

Run emotion analysis alongside STT:

filtered audio
   ├────────────→ STT
   │
   └────────────→ emotion model
                         ↓
                  emotion + confidence

Populate:

emotion
emotionConfidence

in SemanticMessage.

V5C — Language

Use the application's selected language as the authoritative language
metadata initially.

Only introduce a separate language-identification model if required later.

V5D — Voice Profile

Introduce a voice/pitch-based profile for TTS selection.

Do not make biological gender classification a hard requirement.

V6 — Compact Binary Semantic Protocol

After the semantic fields contain real AI-generated information:

JSON SemanticMessage
        ↓
binary compact packet

Then introduce:

message type
sequence number
compact identifiers
framing
payload length
V7 — Encryption

Add encryption after the message format is stable.

V8 — Reliability

Add:

ACK
retry
timeout
deduplication
fragmentation
sequence handling
V9 — Mesh / BitChat Integration

Replace the simple direct BLE transport with multi-hop transport:

Phone A
   ↓
Relay 1
   ↓
Relay 2
   ↓
Phone B

The semantic layer should remain unchanged above the transport.

24. FINAL PRODUCT ARCHITECTURE

Long-term target:

                         PHONE A

                         🎤 MIC
                           │
                           ▼
                    AudioRecord
                           │
                           ▼
                  DeepFilterNet
                           │
                           ▼
                         VAD
                           │
                           ▼
                          STT
                           │
              ┌────────────┴────────────┐
              │                         │
              ▼                         ▼
             TEXT                  Emotion Model
              │                         │
              │                  emotion/confidence
              └────────────┬────────────┘
                           ▼
                    SemanticMessage
                           │
                           ▼
                    Compact Encoding
                           │
                           ▼
                       Encryption
                           │
                           ▼
                      BitChat Mesh
                           │
                ┌──────────┼──────────┐
                ▼          ▼          ▼
              Relay      Relay      Relay
                           │
                           ▼
                         PHONE B
                           │
                           ▼
                       Decryption
                           │
                           ▼
                    Message Decode
                           │
                           ▼
                    SemanticMessage
                           │
                 ┌─────────┴─────────┐
                 │                   │
                 ▼                   ▼
               TEXT              Metadata
                 │                   │
                 └─────────┬─────────┘
                           ▼
                           TTS
                           │
                           ▼
                        🔊 SPEAKER
25. CURRENT STOPPING POINT

At the end of the V5A audit:

V1 BLE Discovery             ✅
V2 BLE GATT + HELLO          ✅
V3 Speech → BLE → Speech     ✅ code
V4 Semantic Message Layer    ✅
V5A DeepFilterNet            🔎 audited, NOT implemented

The next task is NOT "implement everything."

The immediate next task is:

Verify the exact DeepFilterNet3 ONNX model/export
        ↓
Create DeepFilterConfig
        ↓
Create DeepFilterEngine
        ↓
Test independently
        ↓
Integrate into STTModule.onChunk

No BLE architecture changes should be necessary for DeepFilterNet.
No SemanticMessage changes should be necessary merely to add noise
suppression.

26. SOURCE OF TRUTH RULE

This document records project decisions and handoff context.

However:

The live repository source code is always authoritative.

Whenever this document and the repository disagree:

inspect the current implementation
identify the discrepancy
update this document after the decision is confirmed

Do not silently assume this document is newer than the code.

27. LAST VERIFIED V5A FINDINGS

The V5A audit verified:

DeepFilterNet insertion point: STTModule.startListening().onChunk
Current audio: 16 kHz, mono, signed 16-bit PCM
Capture chunk: 4096 bytes / 2048 samples / ~128 ms
ONNX Runtime Android already exists in the repository
IndicConformer already provides an ONNX Runtime usage pattern
Native Rust is not currently part of the repository
DeepFilterNet state should belong to a dedicated DeepFilterEngine
DeepFilterNet must remain above the generic BLE and semantic layers
DeepFilterNet must have a raw-audio fallback
Physical latency, memory, thermal, and audio-quality behavior remain
unverified until Android hardware testing

## Cheers Ritaabannn
