# iTantra — Technical Implementation Notes

This document records the current technical state of the speech, BLE,
semantic-message, audio-enhancement and binary-transport implementation.

The purpose is to keep a clear understanding of what is actually implemented
in the repository and which behavior belongs to which layer.

---

## 1. Overall Architecture

The application is built around the following pipeline:

Microphone
→ audio capture
→ speech enhancement
→ VAD / STT
→ semantic message
→ binary encoding
→ BLE transport
→ binary decoding
→ semantic message
→ TTS
→ speaker

The important architectural separation is:

Speech / AI
→ SemanticMessage
→ Binary protocol
→ Transport
→ BLE

BLE is responsible for transporting bytes. It should not have knowledge of
speech, emotion, language semantics or JSON structure.

---

# 2. Current Audio Format

The Android microphone pipeline currently captures:

- 16 kHz sample rate
- mono
- signed 16-bit PCM
- little-endian
- AudioRecord ByteArray chunks
- current capture chunk size: 4096 bytes
- equivalent to 2048 PCM samples
- approximately 128 ms of audio per capture chunk

The existing STT path converts:

ByteArray
→ ShortArray

The ShortArray representation is used by the VAD and speech enhancement
layers.

---

# 3. Speech Enhancement

The Android runtime speech-enhancement implementation uses an ONNX-based
16 kHz DPDFNet2 model.

The active Android path is:

AudioRecord
→ ByteArray
→ ShortArray
→ DeepFilterEngine
→ enhanced ShortArray
→ VAD + STT

The implementation is contained in:


android/app/src/main/java/com/itantra/audio/DeepFilterConfig.kt
android/app/src/main/java/com/itantra/audio/DeepFilterEngine.kt
android/app/src/main/java/com/itantra/stt/STTModule.kt



The model is bundled under:

android/app/src/main/assets/models/audio/dpdfnet2.onnx

The production Android path is therefore separate from the ML experiment
stored under the ML/ directory.

4. DPDFNet2 Model Contract

The deployed model is:

dpdfnet2.onnx

It is an FP32 ONNX model operating at 16 kHz.

Model input:

spec
FLOAT [1,1,161,2]

state_in
FLOAT [45424]

Model output:

spec_e
FLOAT [1,1,161,2]

state_out
FLOAT [45424]

The model is stateful.

The state_out from one inference frame becomes state_in for the next
frame.

State is reset between independent utterances.

5. Streaming DSP Details

The streaming configuration is:

Frame size: 320 samples
Hop size:   160 samples
Overlap:    160 samples
Sample rate: 16 kHz
Lookahead: 0

The effective frame duration is 20 ms and the hop duration is 10 ms.

Frames therefore overlap:

Frame 1: 0..319
Frame 2: 160..479
Frame 3: 320..639
Frame 4: 480..799
...

The previous non-overlapping frame interpretation was incorrect and would
have discarded a large portion of the audio stream. The implementation was
corrected to use the required 160-sample hop.

The processing path is:

Short PCM
→ frame buffer
→ waveform normalization
→ analysis window
→ DFT/STFT representation
→ ONNX inference
→ enhanced spectrum
→ inverse transform
→ overlap-add
→ enhanced ShortArray

The first streaming hop is used as warm-up and is not emitted as normal
downstream audio.

6. DPDFNet State Handling

The model maintains a 45424-element state buffer.

At the beginning of a new utterance:

state = clean initial state
analysis buffers = reset
overlap-add buffers = reset

During streaming:

frame N
→ state_in
→ ONNX inference
→ state_out
→ frame N+1

The state is not carried between unrelated push-to-talk utterances.

The engine also synchronizes process(), reset() and release() so that
the native model state cannot be modified or released concurrently with an
active inference call.

7. Error Handling in Speech Enhancement

Speech enhancement is deliberately non-fatal.

If the model cannot load or inference fails:

DeepFilter failure
→ original PCM
→ VAD + STT

The application should continue functioning instead of losing the complete
speech pipeline.

ONNX tensors and inference results are explicitly closed on both successful
and failed execution paths.

Empty output from the enhancement warm-up stage is also handled before
passing data to VAD/STT.

8. DeepFilterNet3 ML Experiment

There is another DeepFilterNet-related implementation in the repository under
the ML/ directory.

This is a separate offline experiment.

The current experiment uses:

DeepFilterNet3
Python
Rust/libDF
PyO3
48 kHz audio
Google Colab/offline processing
sample input/output audio files

Relevant files include:

ML/Noise_removal_deepfilternet.ipynb
ML/raw.opus
ML/enhanced.wav
ML/Readme.md

This implementation is not the Android runtime speech path.

It is technically different from the Android DPDFNet2 implementation:

Android runtime:
DPDFNet2
16 kHz
ONNX Runtime
Kotlin
Android

ML experiment:
DeepFilterNet3
48 kHz
Python/Rust
Colab/offline

These should not be treated as the same model or the same runtime.

The ML experiment can produce useful audio-enhancement reference data, but the
Android application currently uses the DPDFNet2 path described above.

9. Existing Speech Pipeline

Normal local speech processing is:

PTT
→ Local speech loop
→ STT
→ local TTS

BLE Voice Mode changes the PTT behavior so that the final STT transcript is
sent through the BLE communication path instead of being spoken locally on
the sender.

The BLE Voice Mode path is:

PTT
→ direct STT
→ final transcript
→ semantic message
→ binary encoding
→ BLE

The receiving side performs:

BLE receive
→ decode semantic message
→ mute microphone
→ TTS
→ unmute microphone

The microphone mute is required to avoid:

TTS speaker
→ microphone
→ STT
→ BLE
→ receiver

feedback loops.

10. Semantic Message

The application-level semantic representation is:

interface SemanticMessage {
  version: number;
  messageId: string;
  text: string;
  language: string;
  emotion: EmotionLabel;
  emotionConfidence: number;
  voiceProfile: string;
}

Current semantic fields are:

version
messageId
text
language
emotion
emotionConfidence
voiceProfile

Current supported emotion values are:

neutral
happy
sad
angry

The current default emotion metadata is:

emotion = neutral
emotionConfidence = 0.0
voiceProfile = default

The semantic representation is independent of BLE.

11. Language Registry

The binary protocol uses a compact numeric language registry rather than
transmitting the complete language string for every message.

Current registered values are:

0x00 = unknown/default
0x01 = en   English
0x02 = hi   Hindi
0x03 = bn   Bengali
0x04 = gu   Gujarati
0x05 = mr   Marathi
0x06 = kn   Kannada
0x07 = ml   Malayalam
0x08 = ta   Tamil
0x09 = te   Telugu
0x0A = or   Odia

0x00 is not an additional spoken language.

It represents an unknown/unregistered language.

This registry is a protocol encoding table. It does not mean that every listed
language necessarily has an independently verified STT/TTS model in the
current Android build.

An unregistered language is encoded as 0x00.

12. Current BLE Architecture

The BLE implementation consists of:

BLEConstants.kt
BLEAdvertiser.kt
BLEScanner.kt
BLEGattServer.kt
BLEGattClient.kt
BLEConnectionManager.kt
BLEModule.kt
BLEPackage.kt

with React Native integration through:

NativeBLE.ts
useBLE.ts
useBLEVoiceMode.ts

Both phones can operate with GATT client/server functionality.

The basic communication direction is:

Phone A:
GATT client
→ writes to TX characteristic

Phone B:
GATT server
→ receives the write

The opposite direction uses:

Phone B:
GATT server
→ sends notification through RX characteristic

Phone A:
GATT client
→ receives notification

The connection manager tracks the current peer and chooses the appropriate
send path.

13. BLE Characteristics

Current service:

12345678-1234-1234-1234-123456789ABC

TX characteristic:

12345678-1234-1234-1234-123456789ABD

RX characteristic:

12345678-1234-1234-1234-123456789ABE

CCCD:

00002902-0000-1000-8000-00805f9b34fb

TX is used for client-to-server writes.

RX is used for server-to-client notifications.

14. BLE Payload Constraints

The current GATT client requests an MTU of:

512 bytes

The normal ATT payload calculation is:

512 - 3 = 509 bytes

Therefore the current transport can carry approximately 509 bytes of
application payload per GATT write when the requested MTU is successfully
negotiated.

There is currently no fragmentation at the BLE layer.

A payload that does not fit is rejected instead of being silently truncated.

15. Binary Semantic Message

The semantic message was originally transmitted as JSON.

The binary protocol changes the application payload representation from:

SemanticMessage
→ JSON
→ bytes
→ BLE

to:

SemanticMessage
→ binary packet
→ bytes
→ BLE

The BLE transport itself does not need to understand the contents.

16. Binary Packet Format

The current binary packet is:

Byte 0       version
Byte 1       messageType
Byte 2       language
Byte 3       emotion
Byte 4       confidence
Byte 5       voiceProfile
Bytes 6–13   messageId
Bytes 14–17  textLength
Bytes 18..   UTF-8 text

Field meanings:

version:
0x02

messageType:
0x01 = TEXT

language:
numeric language registry

emotion:
0x00 = neutral
0x01 = happy
0x02 = sad
0x03 = angry

confidence:
UInt8 representation of emotion confidence

voiceProfile:
0x00 = default

messageId:
UInt64 BIG_ENDIAN

textLength:
UInt32 BIG_ENDIAN

text:
UTF-8 bytes

The fixed header is 18 bytes.

Total packet size is:

18 + UTF-8 text byte length
17. Text Encoding

Text is encoded as UTF-8.

This is important because transcripts may contain:

English
Hindi
Bengali
other Unicode
emoji
supplementary Unicode characters

The length field counts UTF-8 bytes, not JavaScript characters.

Therefore:

textLength = number of UTF-8 bytes

and not:

text.length

A manual UTF-8 implementation is used in the React Native protocol layer to
avoid depending on unavailable TextEncoder/TextDecoder behavior in the
current Hermes environment.

The implementation handles surrogate pairs and has tests for multilingual
text and emoji.

18. Confidence Encoding

Emotion confidence is normally a floating point value:

0.0 → 1.0

It is compressed into one byte:

encoded = round(clamp(confidence, 0, 1) × 255)

Decoded using:

confidence = encoded / 255

This gives approximately 0.4% resolution while saving three bytes compared
with transmitting a Float32 value.

19. Message ID Encoding

The semantic message originally uses a string ID similar to:

msg_<timestamp>_<random>_<counter>

The binary protocol does not transmit this variable-length string.

Instead it stores a 64-bit FNV-1a hash of the UTF-8 bytes of the original
message ID.

The FNV-1a constants are:

Offset basis:
0xcbf29ce484222325

FNV prime:
0x100000001b3

The hash is transmitted as an unsigned 64-bit BIG_ENDIAN value.

The original string cannot be reconstructed from the hash.

The hash is used as a compact deterministic wire identity.

The current application does not depend on recovering the original string
from the network packet.

20. Binary Protocol Validation

The decoder rejects packets with:

packet too short
unsupported version
invalid message type
invalid language
invalid emotion
invalid voice profile
empty text
truncated text
invalid UTF-8

There are safe-decoding paths so malformed network input does not crash the
application.

Validation happens before the decoded message is passed into the existing
speech/TTS path.

21. V4 JSON Compatibility

Existing JSON messages are still understood.

The receive side distinguishes:

0x02
→ binary semantic packet

and:

0x7B
→ legacy JSON object beginning with "{"

The existing JSON semantic codec remains available for compatibility.

Therefore an older JSON-based build can still communicate with the newer
receive path during the transition.

The BLE transport does not need to know which application format is being
used.

22. JavaScript / Native BLE Boundary

The binary packet is still represented as Base64 when crossing the current
React Native/native module boundary.

Sender:

Uint8Array
→ byte-compatible character representation
→ Base64
→ NativeBLE.send()

Native side:

Base64
→ ByteArray
→ BLE transport

Receiver:

BLE ByteArray
→ Base64
→ JavaScript
→ Uint8Array
→ binary decoder

Base64 here is only a bridge representation.

It is not the semantic protocol itself.

There is no second Base64 layer around the packet.

23. Payload Efficiency

The binary representation removes the repeated JSON field names and the
large string representation of metadata.

For a short text such as:

Hello judges

the UTF-8 text is 12 bytes.

The binary packet is therefore:

18-byte header
+
12-byte text
=
30 bytes

The important savings come from replacing verbose JSON metadata with fixed
numeric fields.

The exact savings depend on:

message ID representation
text length
Unicode encoding
JSON formatting

The binary representation is particularly useful for short speech messages
where JSON metadata would otherwise be a large fraction of the packet.

24. Separation Between Layers

The current implementation deliberately keeps the following boundaries:

Speech processing
        ↓
SemanticMessage
        ↓
BinaryMessageCodec
        ↓
transport bytes
        ↓
BLE

The BLE code does not parse:

language
emotion
text
voice profile
JSON
semantic message structure

The semantic code does not need to know:

BluetoothDevice
GATT
characteristic UUIDs
Android BLE APIs

This separation makes debugging significantly easier because each layer has
a specific responsibility.

25. Verification Performed

Static and unit verification currently includes:

TypeScript compilation
→ 0 errors

Binary protocol tests:

63 tests
63 passed

The tests cover:

round-trip encoding/decoding
deterministic encoding
English
Hindi
Bengali
emoji
emotions
confidence
language mapping
message ID hashing
malformed packets
truncated packets
endian encoding
packet size
BLE overflow
JSON fallback
validation behavior

The speech-enhancement implementation also has dedicated tests covering its
buffering and state-management behavior.

26. Important Distinctions

Several pieces of work in the repository look similar but are technically
different.

Speech enhancement

The active Android speech path uses DPDFNet2 at 16 kHz.

DeepFilterNet3 experiment

The ML/ work is a separate 48 kHz Python/Rust experiment.

BLE transport

BLE only moves bytes.

SemanticMessage

SemanticMessage represents the meaning of the speech result.

BinaryMessageCodec

The binary codec converts SemanticMessage into a compact byte representation.

TTS

The receiver consumes the decoded semantic text and produces speech.

Keeping these distinctions clear prevents changes in one area from
accidentally changing another area.

27. Current Technical State

The current communication path is:

Microphone
→ 16 kHz PCM
→ speech enhancement
→ VAD / STT
→ SemanticMessage
→ binary encoding
→ Base64 bridge
→ BLE GATT
→ Base64 decode
→ binary decoding
→ SemanticMessage
→ TTS
→ Speaker

The implementation is designed so that BLE is only the current transport
mechanism and the speech/semantic layers remain independent of the Bluetooth
implementation.

28. Physical Device Verification Status

The following require real Android devices to validate completely:

actual Android model loading
DPDFNet2 runtime inference
speech-enhancement quality
real-time inference latency
CPU/memory behavior
repeated-session stability
BLE discovery on physical phones
GATT connection behavior
bidirectional message exchange
actual binary packet transmission
V4/V6A interoperability between builds
end-to-end speech → STT → BLE → TTS behavior

Static tests and source-level verification cannot substitute for these
physical tests.

29. Main Technical Corrections Made

The most important corrections incorporated into the implementation are:

Streaming speech enhancement uses a 320-sample frame with a 160-sample
hop instead of incorrectly using non-overlapping frames.
Stateful enhancement is reset correctly between utterances.
ONNX resources are closed on both success and failure paths.
Empty enhancement output is not passed into VAD/STT.
Native enhancement state is protected against concurrent reset/process/
release operations.
BLE server-side connections are correctly represented in the connection
manager.
Bidirectional BLE sending uses the appropriate GATT write or notification
path.
Semantic messages are represented by compact binary packets instead of
relying exclusively on JSON.
Unicode text is encoded using UTF-8 byte lengths rather than JavaScript
character counts.
Binary packet integers use explicit BIG_ENDIAN encoding.
Legacy JSON reception remains supported.
Binary packets are rejected when they exceed the currently supported
transport payload instead of being silently truncated.
Final Current Pipeline
             SPEECH INPUT
                  │
                  ▼
            AudioRecord
                  │
                  ▼
           16 kHz PCM
                  │
                  ▼
          Speech Enhancement
                  │
                  ▼
          ┌───────┴───────┐
          │               │
          ▼               ▼
         VAD             STT
                          │
                          ▼
                  SemanticMessage
                          │
                          ▼
                BinaryMessageCodec
                          │
                          ▼
                    BLE Transport
                          │
                          ▼
                BinaryMessageCodec
                          │
                          ▼
                  SemanticMessage
                          │
                          ▼
                         TTS
                          │
                          ▼
                      Speaker
