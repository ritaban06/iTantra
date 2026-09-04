iTantra – System Architecture and Current Implementation

Indian Multilingual TTS & STT Aided Neural Transceiver Radio Access for low bitrate links

Current code-base reference: feature/ble-transport-v1 / commit 9f833a1

1. Project idea

Voice information is much larger than text, which makes direct audio transmission inefficient over low data-rate links. At the same time, in emergency, alert and distress situations, voice is often more useful and more inclusive than a written message.

iTantra solves this by keeping the audio local and transmitting text instead of raw audio.

The basic idea is:

Person speaks
    ↓
Local STT
    ↓
Text / semantic message
    ↓
BLE / BITCHAT mesh transport
    ↓
Remote phone
    ↓
Text
    ↓
Local TTS
    ↓
Person hears the message

This keeps the expensive audio processing on the phone and makes the radio link carry a much smaller representation of the speech.

The project is intended for low and mid-range Android phones and is designed around fully offline speech processing and open-source components.

2. What the current code base contains

The current branch is not just a speech demo. It is a complete communication stack with the following major layers:

┌──────────────────────────────────────────────────────────────┐
│                         iTantra App                          │
│  Home / Connect / Voice Mode / Benchmark / Diagnostics      │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│                      React Native Layer                      │
│  Hooks + Native JS wrappers + navigation + state            │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│                    Android Native Bridge                    │
│      BLE Native Module + Sherpa Native Module (experimental) │
└───────────────┬──────────────────────────────┬──────────────┘
                │                              │
                ▼                              ▼
┌───────────────────────────┐     ┌────────────────────────────┐
│       BLE / Mesh           │     │       Local Speech         │
│                           │     │                            │
│ GATT client/server        │     │ STT / TTS / VAD            │
│ Packet framing            │     │ Sherpa-ONNX runtime        │
│ V6A semantic messages     │     │ English + Hindi models     │
│ V6B transport frames      │     │ Silero VAD                 │
│ V7 fragmentation          │     │ AudioTrack playback        │
│ V8 reliability            │     │                            │
│ V9 BITCHAT mesh           │     │                            │
└───────────────┬───────────┘     └────────────────────────────┘
                │
                ▼
       ┌───────────────────┐
       │ Bluetooth link(s) │
       │ + BITCHAT relays  │
       └───────────────────┘

A key point when reading the current code is that the transport stack is the mature part, while the Sherpa speech stack is currently integrated as a native, locally executable speech path with a dedicated diagnostic screen. The existing production speech path has not been removed or silently replaced.

3. Application layer

The top layer is the React Native application.

Important screens/components include:

src/
├── screens/
│   ├── HomeScreen.tsx
│   ├── ConnectScreen.tsx
│   ├── BenchmarkScreen.tsx
│   ├── SherpaDiagnosticScreen.tsx
│   └── __tests__/
│
├── navigation/
│   └── AppNavigator.tsx
│
├── hooks/
│   ├── useBLE.ts
│   ├── useBLEVoiceMode.ts
│   ├── usePTT.ts
│   ├── useSTT.ts
│   ├── useTTS.ts
│   ├── voiceDestinationStore.ts
│   └── __tests__/
│
└── native/
    ├── NativeBLE.ts
    └── NativeSherpa.ts

The React Native layer is responsible for UI, communication state, user interaction and calling native Android functionality.

The native modules are intentionally kept below this layer because BLE operations and neural speech inference are better handled by native Android code rather than by trying to do the heavy work directly in JavaScript.

4. Speech pipeline

4.1 Speech-to-text concept

The intended speech path is:

Microphone
   ↓
16 kHz mono PCM16 audio
   ↓
Noise suppression / preprocessing
   ↓
VAD detects speech and pauses
   ↓
STT model
   ↓
Recognized sentence
   ↓
SemanticMessage
   ↓
BLE transport

The existing audio capture path uses 16 kHz mono PCM16 audio. Earlier production speech processing uses DeepFilterNet2 noise suppression and a simple energy-based VAD. The code base also contains the new Silero VAD path inside the Sherpa integration.

4.2 Current production STT path

The existing production speech path still contains:

Vosk for English

IndicConformer runtime model support for Hindi/Bengali

local audio capture

sentence/utterance handling around speech pauses

This path is separate from the newly integrated Sherpa stack.

4.3 Current Sherpa STT path

Sherpa-ONNX has now been integrated natively into Android.

Current bundled STT assets:

android/app/src/main/assets/sherpa/
├── en-stt/
│   ├── decoder.onnx
│   ├── encoder.int8.onnx
│   ├── joiner.int8.onnx
│   └── tokens.txt
│
└── hi-stt/
    ├── model.int8.onnx
    └── tokens.txt

The English model is set up for the online/streaming recognizer path.

The Hindi model is currently used through an offline recognizer path because the tested export is a CTC-style model and is not currently proven as a Sherpa online transducer model in this Android integration.

This distinction is important: Hindi STT is integrated and testable, but streaming Hindi STT is not yet claimed as complete.

5. Voice activity detection

VAD is used to decide where speech begins and ends so that the application does not continuously transmit microphone audio.

The intended behaviour is:

Idle listening
     ↓
Speech detected
     ↓
Collect speech
     ↓
Pause / stoppage detected
     ↓
Finalize utterance
     ↓
STT
     ↓
Transmit text

The current Sherpa stack contains Silero VAD:

android/app/src/main/assets/sherpa/vad/silero_vad.onnx

The physical-device diagnostic screen includes a dedicated VAD test.

6. Text-to-speech path

The receiver performs the reverse operation:

BLE packet
   ↓
Transport reassembly
   ↓
Semantic text
   ↓
TTS engine
   ↓
PCM audio
   ↓
Android AudioTrack
   ↓
Speaker

The Sherpa TTS integration currently bundles English and Hindi model assets:

android/app/src/main/assets/sherpa/
├── en-tts/
│   ├── model.onnx
│   └── tokens.txt
│
└── hi-tts/
    ├── model.onnx
    └── tokens.txt

The native TTS implementation generates local audio and plays it through Android audio playback.

The current code base also still contains the older Android system TextToSpeech production path. Therefore the Sherpa TTS path should currently be considered the open-source offline speech-engine integration path, while the final production engine selection remains a separate integration decision.

7. Multilingual scope

The project target is 10 languages:

Hindi
Gujarati
Marathi
Kannada
Malayalam
Tamil
Telugu
Odia
Bengali
English

The architecture is intentionally model-pack based so that each language can have its own STT/TTS assets and configuration rather than forcing one large model to contain every language.

Current implementation status

English     → Sherpa STT + Sherpa TTS assets bundled
Hindi       → Sherpa STT + Sherpa TTS assets bundled
Silero VAD  → bundled

Other target languages
            → language architecture/UI support exists,
              but complete offline Sherpa STT + TTS packs are not
              yet bundled and validated for all eight remaining languages

So the architecture is prepared for ten languages, but the current committed speech assets do not constitute a validated ten-language final system yet.

8. Communication architecture

The communication side is based on a layered binary protocol developed specifically for iTantra.

The stack is:

Application text
      ↓
V6A semantic protocol
      ↓
V7 fragmentation (when required)
      ↓
V6B transport framing
      ↓
BLE GATT transport
      ↓
Optional BITCHAT mesh forwarding

9. Semantic protocol – V6A

V6A is the application/message representation.

It carries the information that higher layers need to communicate, instead of sending raw audio bytes.

The important design principle is:

VOICE AUDIO (large)
        ↓
      local STT
        ↓
 TEXT / SEMANTIC MESSAGE (small)
        ↓
       radio

The standalone V6A maximum payload is approximately 491 bytes and the transport-level maximum payload is 499 bytes after accounting for framing overhead.

The exact packet definitions are implemented in the protocol code rather than being inferred from the UI.

10. Transport protocol – V6B

V6B provides the transport frame around the semantic payload.

The current design uses:

10-byte transport header

maximum 509-byte frame size

maximum 499-byte transport payload

per-peer sequence management

This is the layer that connects the logical message system to the actual BLE data transfer.

11. Fragmentation – V7

BLE and the transport layer cannot assume that a complete application message will always fit in a single packet.

V7 therefore splits a larger V6A message into chunks.

Large semantic message
        ↓
   V7 fragmentation
        ↓
┌──────┬──────┬──────┬──────┐
│ frag │ frag │ frag │ frag │ ...
└──────┴──────┴──────┴──────┘
        ↓
      BLE
        ↓
fragment reassembly
        ↓
complete V6A message

The current fragmentation header is 9 bytes, with a maximum chunk size of about 490 bytes and a maximum of 128 fragments per message.

12. Reliability – V8

V8 adds acknowledgements and retransmission for reliable direct peer communication.

Current behaviour includes:

per-peer ReliabilityManager

ACK timeout of about 2 seconds

up to 3 retries

delivery/completion caches

fragment group expiry around 30 seconds

Conceptually:

Sender
  │
  │ data
  ▼
Receiver
  │
  │ ACK
  ▼
Sender

If the expected ACK is not received within the configured timeout, the sender can retry.

An important current limitation is that this V8 reliability loop is primarily wired around direct peer messaging. BITCHAT mesh hop forwarding is currently best-effort at the mesh layer and is not fully integrated into the same end-to-end ACK/retransmission loop.

13. BITCHAT mesh layer

The BITCHAT layer extends the direct BLE link into a multi-hop network.

The main pieces are:

NodeIdStore
    ↓
BitChatBLEAdapter
    ↓
RelayEngine / MeshRouter
    ↓
Mesh discovery / deduplication / forwarding

Packet foundation

The BITCHAT frame uses a 28-byte packet header with fields including source node ID, destination node ID, packet ID, TTL and related routing information.

Relay behaviour

The relay engine performs controlled flooding rather than maintaining a complex global routing table.

Basic flow:

Node A
  ↓
Node B
  ↓
Node C
  ↓
Node D

Each node forwards a message when appropriate while avoiding loops through packet deduplication and TTL handling.

Deduplication

A packet that has already been seen is not forwarded again. This keeps controlled flooding from becoming an infinite loop.

TTL

The TTL limits the number of forwarding hops.

Incoming-peer exclusion

A relay does not immediately send the same frame back through the peer from which it received that frame.

14. Mesh discovery

V9D added a discovery packet type and a MeshDiscoveryRegistry.

The registry is advisory: it records knowledge of nearby/seen mesh nodes, while actual forwarding remains under the mesh/router logic.

Direct ANNOUNCE behaviour remains direct-link oriented rather than pretending that announcement packets were already fully relayed throughout the mesh.

15. BLE architecture

The native Android BLE implementation is split into client/server/connection management layers.

Relevant files include:

android/app/src/main/java/com/itantra/ble/
├── BLEConnectionManager.kt
├── BLEGattClient.kt
├── BLEGattServer.kt
├── BLEModule.kt
└── ...

The JavaScript side talks to the native BLE module through:

src/native/NativeBLE.ts

and application behaviour is exposed through:

src/hooks/useBLE.ts
src/hooks/useBLEVoiceMode.ts

This separation makes the transport implementation independent of the React UI.

16. End-to-end communication example

Sender phone

Microphone
   ↓
AudioCaptureManager
   ↓
VAD / speech boundary detection
   ↓
STT
   ↓
"Please send help"
   ↓
SemanticMessage
   ↓
V6A
   ↓
V7 fragmentation (only if necessary)
   ↓
V6B frame
   ↓
BLE GATT

Mesh forwarding

Phone A
   ↓ BLE
Phone B
   ↓ BLE
Phone C

Phone B can act as a relay according to the BITCHAT mesh rules.

Receiver phone

BLE GATT
   ↓
V6B decode
   ↓
V7 reassembly
   ↓
V6A semantic message
   ↓
Text
   ↓
TTS
   ↓
AudioTrack
   ↓
Speaker

The important optimisation is that the radio never needs to carry the original microphone waveform for normal voice messaging.

17. Push-to-talk and voice mode

The application has voice-mode hooks and a PTT hook.

The intended interaction is:

PTT pressed
    ↓
start / allow speech capture
    ↓
speak
    ↓
PTT released or speech stops
    ↓
finalize utterance
    ↓
STT
    ↓
send text

The project description also calls for a phone-like mode when PTT is disabled. The current code contains the voice-mode state and transport plumbing, but a complete production-grade phone-call UX over the text/Speech architecture should not be treated as fully finished unless it is explicitly validated in the current build.

18. Alert message concept

Alert and distress messages are a special requirement because they must be heard even in situations where ordinary notification behaviour would not be sufficient.

The intended receiver-side flow is:

Alert semantic message
        ↓
priority handling
        ↓
high-volume / non-interruptible playback

The current code base has the communication foundation required to carry distinct message semantics, but the complete final alert policy (priority, audio focus, volume behaviour and non-interruptible handling) still requires end-to-end validation before claiming the requirement is fully completed.

19. Offline requirement

The architecture is designed so that speech inference occurs locally.

For the Sherpa speech stack:

Microphone audio
      ↓
local ONNX model
      ↓
local text

received text
      ↓
local ONNX TTS model
      ↓
local audio

No cloud STT or cloud TTS API is required by this path.

The Sherpa ONNX native runtime and model assets are bundled in the Android project, while the larger ONNX files are stored through Git LFS.

20. Native Sherpa integration

The Android project contains both the project-specific wrapper layer and the Sherpa ONNX Kotlin classes.

android/app/src/main/java/com/itantra/sherpa/
├── SherpaOnnxModule.kt
├── SherpaOnnxPackage.kt
├── SherpaOnnxSTTEngine.kt
├── SherpaOnnxTTSEngine.kt
└── SherpaOnnxVadEngine.kt

The imported/generated Sherpa ONNX Kotlin API classes live under:

android/app/src/main/java/com/k2fsa/sherpa/onnx/

Native libraries are bundled for:

arm64-v8a
armeabi-v7a

The JavaScript entry point is:

src/native/NativeSherpa.ts

This gives the React Native application access to local native STT/TTS/VAD functionality without making the JavaScript layer responsible for neural-network execution.

21. Physical Android testing

21.1 Do not use an emulator for this project test

The Sherpa Android runtime is memory-heavy and the generated debug APK is large. Physical-device testing is the expected validation route for the current integration.

Team members should use a real Android phone rather than an emulator for the speech tests.

21.2 Get the current code

Clone the repository or update an existing clone:

git clone https://github.com/ritaban06/iTantra.git
cd iTantra
git checkout feature/ble-transport-v1
git pull origin feature/ble-transport-v1

Because the neural-network files are stored with Git LFS, make sure Git LFS is installed and the large model files are present:

git lfs install
git lfs pull

The current Sherpa checkpoint is:

9f833a1  checkpoint: add Sherpa speech stack

21.3 Build the Android debug APK

From the repository:

cd android
.\gradlew :app:assembleDebug

The successful build currently produces:

android/app/build/outputs/apk/debug/app-debug.apk

The current debug APK is approximately 731 MB on disk because the bundled speech models and native libraries are included.

21.4 Install on a physical phone

On the Android phone:

Enable Developer options.

Enable USB debugging.

Connect the phone through USB.

Accept the RSA debugging prompt on the phone.

On the PC, verify the device:

adb devices

Then install:

adb install -r .\app\build\outputs\apk\debug\app-debug.apk

The package/application is based on the com.itantra Android namespace used by the project.

If installation succeeds, open iTantra normally from the phone. The Sherpa diagnostic entry can then be opened from the application home screen.

22. Sherpa diagnostic test plan

The current code includes a dedicated SherpaDiagnosticScreen so that the native speech stack can be tested without changing the existing production speech path.

Test 1 – English STT streaming

Purpose: verify the complete native online recognizer path.

Open Sherpa Diagnostics
        ↓
Load English STT
        ↓
Start microphone test
        ↓
Speak a simple sentence
        ↓
Observe partial / final transcription

Expected result:

model loads successfully

microphone capture works

partial results appear while speaking

final text is returned after the utterance completes

Test 2 – Hindi STT

Purpose: verify local Hindi recognition.

Use a normal Hindi sentence and check the final transcription.

Important: the current Hindi model is tested through the offline recognizer path. Do not record this test as evidence of streaming Hindi STT.

Test 3 – Silero VAD

Purpose: check speech segmentation.

Start VAD test
   ↓
speak
   ↓
pause
   ↓
speak again
   ↓
stop

Check that speech regions are detected separately and that silence does not get treated as speech.

Test 4 – English TTS

Enter a short English sentence and run TTS.

Expected:

Text
 ↓
Sherpa TTS
 ↓
Generated PCM
 ↓
Phone speaker

The phone should produce intelligible speech without internet access.

Test 5 – Hindi TTS

Repeat the TTS test with a Hindi sentence.

Check pronunciation, continuity and intelligibility.

Test 6 – Offline test

After the models are installed:

Put the phone in airplane mode.

Keep Wi-Fi and mobile data disabled.

Repeat the STT, VAD and TTS diagnostics.

Expected result: the Sherpa tests continue to work because the speech models are local.

Test 7 – Lifecycle test

Run a speech test, leave the screen, return to it, and repeat the test.

Also try:

Open diagnostic
 → start
 → stop
 → leave screen
 → return
 → start again

The native resources should be released and recreated cleanly without crashing.

23. BLE physical test

For a two-phone communication test, use two real Android phones with the same branch/build.

Basic setup:

Phone A                         Phone B
────────                        ────────
STT / voice mode               TTS / receive mode
      │                              ▲
      └──────── BLE connection ──────┘

Test sequence:

Phone A:
Speak a sentence
   ↓
STT produces text
   ↓
semantic message is sent

Phone B:
receives text
   ↓
TTS converts text to speech
   ↓
speaker plays message

For a mesh test, introduce a third phone:

Phone A  →  Phone B  →  Phone C
 sender       relay       receiver

Phone B should relay the BITCHAT frame according to the TTL, deduplication and forwarding rules rather than simply acting as the final receiver.

24. What is already implemented

Communication stack

V6A semantic protocol            ✅
V6B transport                    ✅
V7 fragmentation                 ✅
V8 direct reliability            ✅
V9 BITCHAT mesh foundation       ✅
V9C BLE BITCHAT transport        ✅
V9D mesh discovery               ✅
Relay / dedup / TTL              ✅

Android / React Native integration

BLE native module                ✅
BLE React hooks                  ✅
Voice-mode communication logic  ✅
Sherpa native module             ✅
Sherpa Kotlin bindings           ✅
Native ONNX libraries            ✅
Physical-device diagnostic UI    ✅

Speech assets in current branch

English STT                     ✅
Hindi STT                       ✅
English TTS                     ✅
Hindi TTS                       ✅
Silero VAD                      ✅

Build / packaging

Android native compile           ✅
React/TypeScript build checks    ✅
Debug APK generation             ✅
Git LFS model packaging          ✅

25. What is not yet complete

The following should not be presented as finished merely because the framework or hooks exist.

Ten-language final speech stack

The target is ten languages, but the current committed Sherpa speech assets cover English and Hindi only. The other target languages still require their final offline STT/TTS model selection, packaging and physical validation.

Final open-source production TTS selection

The Sherpa TTS path is integrated, but the final production voice/model choice still needs to be locked down together with its licensing and performance measurements for the submission requirements.

Hindi streaming STT

Hindi STT is integrated through an offline recognition path. A fully validated streaming Hindi recognizer is not claimed yet.

Wi-Fi transport

The current communication implementation is BLE/mesh focused. A completed Wi-Fi transport path is not part of this checkpoint.

Full phone-call mode

The current voice/PTT plumbing exists, but the complete phone-like continuous conversation behaviour requested in the original project statement still needs end-to-end validation.

Final alert behaviour

The application has semantic-message and transport foundations for alert handling, but the final highest-volume/non-interruptible alert policy needs dedicated validation.

Performance measurements

The architecture supports the required evaluation metrics, but final submission numbers for:

WER

TTS human intelligibility/quality

STT latency

TTS latency

end-to-end sentence-to-remote-audio latency

RTF on target low/mid-range phones

RAM / Flash footprint

idle CPU usage

must come from controlled measurements on physical target devices rather than estimates from the development PC.

26. Evaluation metrics and how the architecture maps to them

Efficiency – 20%

The main efficiency strategy is to transmit text rather than raw speech.

Measurements should include:

Model size
APK / Flash footprint
Runtime RAM
Idle-listening CPU usage

For a fair result, these should be measured on the actual target phone classes.

Accuracy – 40%

STT:

Reference transcript
       ↕
Recognized transcript
       ↓
WER

TTS should be judged using human intelligibility, pronunciation, continuity and natural flow.

Latency – 20%

Important timestamps are:

speech begins
     ↓
STT final result
     ↓
message transmitted
     ↓
remote text received
     ↓
TTS audio ready
     ↓
remote audio starts

The most useful end-to-end number is:

sentence spoken on Phone A
          →
first corresponding audio heard on Phone B

RTF should also be recorded:

RTF = processing time / audio duration

For real-time operation, lower is better.

27. Why the architecture is suitable for a low-bit-rate radio link

The radio does not need to transport:

16 kHz PCM16 audio

for normal voice communication.

Instead it transports a compact text/semantic representation:

Speech
 ↓
STT
 ↓
Text
 ↓
Binary semantic packet
 ↓
BLE / mesh

The reverse side reconstructs the audible message locally:

Binary semantic packet
 ↓
Text
 ↓
TTS
 ↓
Audio

That is the central architectural reason iTantra can target communication over links where raw audio would be expensive or impractical.

28. Repository structure relevant to the system

iTantra/
│
├── android/
│   └── app/
│       └── src/main/
│           ├── assets/
│           │   └── sherpa/
│           │       ├── en-stt/
│           │       ├── en-tts/
│           │       ├── hi-stt/
│           │       ├── hi-tts/
│           │       └── vad/
│           │
│           ├── java/com/itantra/
│           │   ├── ble/
│           │   └── sherpa/
│           │
│           ├── java/com/k2fsa/sherpa/onnx/
│           │
│           └── jniLibs/
│               ├── arm64-v8a/
│               └── armeabi-v7a/
│
├── src/
│   ├── hooks/
│   ├── navigation/
│   ├── native/
│   └── screens/
│
└── scripts/

The large ONNX model files are handled through Git LFS. The Android build directory remains generated output and is not part of the source checkpoint.

29. Current checkpoint

The current GitHub checkpoint for this architecture is:

Branch : feature/ble-transport-v1
Commit : 9f833a1
Message: checkpoint: add Sherpa speech stack

At this point the branch is synchronized with GitHub and contains the current BLE/mesh stack, the native Sherpa integration, the bundled English/Hindi speech assets, diagnostics, tests and supporting code.

The next stage is not to redesign the communication foundation. It is to physically validate the current Android speech and BLE stack, measure the required metrics, and then complete the remaining language/transport/UX requirements against the original project specification.

30. One-line system summary

Local speech → text → compact semantic packet → BLE / BITCHAT mesh → text → local speech

That is the core iTantra architecture.