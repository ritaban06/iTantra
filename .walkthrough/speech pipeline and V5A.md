CURRENT SPEECH PIPELINE
Normal local mode
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
direct STT
 ↓
STT_RESULT
 ↓
SemanticMessage
 ↓
BLE

Receiver:

BLE
 ↓
SemanticMessage
 ↓
mute microphone
 ↓
TTS
 ↓
unmute microphone

The microphone mute prevents:

TTS speaker
 ↓
microphone
 ↓
STT
 ↓
BLE
 ↓
loop
7. CURRENT SEMANTIC MESSAGE

V4 introduced:

{
  "version": 1,
  "messageId": "...",
  "text": "...",
  "language": "en",
  "emotion": "neutral",
  "emotionConfidence": 0.0,
  "voiceProfile": "default"
}

Current emotions:

neutral
happy
sad
angry

Current defaults:

emotion = "neutral"
emotionConfidence = 0.0
voiceProfile = "default"

The semantic layer remains above BLE.

Desired layering:

Speech / AI
     ↓
SemanticMessage
     ↓
Future Binary Protocol
     ↓
BLE Transport
     ↓
Future BitChat Mesh

Do NOT put semantic parsing inside BLE transport.

8. V5A — DEEPFILTERNET / DPDFNET2
Status

V5A is IMPLEMENTED AND COMMITTED.

Commit:

ce6e85d

The implementation uses:

DPDFNet2 16 kHz

Model:

dpdfnet2.onnx

The model is bundled locally for offline use.

9. V5A MODEL CONTRACT

Verified model:

Model:
DPDFNet2 16 kHz

Format:
ONNX

Precision:
FP32

Sample rate:
16,000 Hz

ONNX opset:
17

Input:
spec FLOAT [1,1,161,2]
state_in FLOAT [45424]

Output:
spec_e FLOAT [1,1,161,2]
state_out FLOAT [45424]

Streaming parameters:

FFT/frame size:
320 samples = 20 ms

Hop:
160 samples = 10 ms

Overlap:
160 samples = 50%

Lookahead:
0

Window:
Vorbis window

State:
45,424 Float32 values

State initialization:
all zeros
10. CURRENT iTantra AUDIO FORMAT

The current microphone pipeline uses:

16 kHz
mono
16-bit signed PCM
little-endian

Audio capture:

ByteArray[4096]

which equals:

2048 samples

or approximately:

128 ms

Current conversion:

ByteArray
 ↓
ShortArray

VAD consumes:

ShortArray

STT receives:

ByteArray
11. V5A INSERTION POINT

DeepFilterNet is inserted at:

STTModule.startListening()

inside the:

onChunk

processing path.

Current intended pipeline:

AudioRecord
    ↓
ByteArray[4096]
    ↓
ShortArray
    ↓
DeepFilterEngine
    ↓
enhanced ShortArray
    ├──→ VAD
    └──→ ByteArray → STT

The following remain unchanged:

AudioCaptureManager
VoiceActivityDetector
VoskSTTEngine
IndicConformerSTTEngine
BLE
SemanticMessage
TTS
UI
12. V5A FILES CREATED

Created:

android/app/src/main/java/com/itantra/audio/DeepFilterConfig.kt

android/app/src/main/java/com/itantra/audio/DeepFilterEngine.kt

android/app/src/main/assets/models/audio/dpdfnet2.onnx

android/app/src/test/java/com/itantra/audio/DeepFilterConfigTest.kt

android/app/src/test/java/com/itantra/audio/DeepFilterEngineTest.kt

Modified:

android/app/src/main/java/com/itantra/stt/STTModule.kt
13. V5A STREAMING IMPLEMENTATION

The engine maintains:

stateIn
analysis buffer
overlap-add buffer
started flag
input buffer

The streaming approach uses:

320-sample frame
160-sample hop

The analysis window slides by 160 samples.

The first hop is suppressed as warm-up.

Steady-state processing produces one 160-sample output hop per 160 input
samples.

14. V5A DSP CORRECTIONS PERFORMED

The first implementation had several problems.

Those were corrected before committing V5A.

Corrected issue 1 — window

Initial implementation:

Hann

Corrected to:

Vorbis window

matching the verified reference implementation.

Corrected issue 2 — framing

Initial implementation incorrectly used non-overlapping 320-sample blocks.

Correct implementation uses:

320 frame
160 hop
50% overlap
Corrected issue 3 — analysis buffer

The implementation now uses a sliding analysis buffer matching the official
reference approach.

Corrected issue 4 — warm-up

The first hop is consumed but not output.

Corrected issue 5 — DFT normalization

Correct behavior:

Forward DFT:
no 1/N normalization

Inverse DFT:
1/N normalization
Corrected issue 6 — overlap-add

The implementation now shifts the overlap-add buffer, clears the tail,
adds the synthesis frame, and outputs the first hop.

15. V5A SAFETY FIXES

A final code review identified several issues before checkpointing.

These were fixed.

ONNX resource leak

OnnxTensor and OrtSession.Result are now closed in a finally path even
if inference fails.

Empty VAD input

DeepFilter warm-up can return no enhanced samples.

The STTModule now:

if processedArray is empty
    skip VAD
    skip STT

instead of sending an empty array to VAD.

Thread safety

process(), reset(), and release() are synchronized so reset/release
cannot race with ongoing model processing.

16. V5A FALLBACK

If DPDFNet2 cannot load or inference fails:

DeepFilter failure
     ↓
raw PCM
     ↓
VAD + STT

The application must continue operating without noise suppression.

The emotion/protocol/BLE pipeline must never depend on successful
DeepFilter inference.

17. V5A TESTING STATUS

Static checks completed:

npx tsc --noEmit
✅ EXIT 0

git diff --check
✅ EXIT 0

Additional V5A tests were added for:

configuration constants
frame/hop buffering
overlapping frames
first-hop suppression
buffer continuity
state reset
output range/clamping
synchronization/control flow
fallback behavior
overlap-add buffer logic

Total reported tests:

26
18. V5A PHYSICAL TESTING STILL REQUIRED

Physical Android testing has NOT been done in this environment.

A collaborator must verify:

Android APK builds successfully.
DPDFNet2 loads from assets.
DPDFNet2 inference runs without crash.
Normal local PTT still works.
Vosk English STT still works.
IndicConformer Hindi/Bengali still works.
DPDFNet2 improves speech quality in noisy environments.
Average inference time per frame is acceptable.
No memory leak occurs across repeated PTT sessions.
BLE Voice Mode still works.
STT → SemanticMessage → BLE → TTS still works.
microphone mute/unmute feedback prevention still works.
no thermal or severe battery issue appears during normal usage.

Important:

Do not claim DPDFNet2 is physically validated until these tests are performed.

19. V5B — EMOTION RESEARCH

V5B was investigated but NOT implemented.

The goal was:

enhanced PCM
   ↓
emotion model
   ↓
emotion + confidence
   ↓
SemanticMessage

The intended architecture was:

AudioRecord
   ↓
DPDFNet2
   ↓
enhanced PCM
   ├──→ VAD + STT
   └──→ EmotionBuffer
            ↓
        PTT release
            ↓
      Emotion inference
            ↓
      SemanticMessage

Emotion should be computed after the utterance rather than trying to run a
full emotion classifier every 10 ms.

20. V5B CANDIDATES INVESTIGATED

Candidates included:

SpeechBrain wav2vec2 emotion
SpeechBrain ECAPA-TDNN
DistilHuBERT emotion
Dpngtm wav2vec2 emotion
prithivMLmods Speech-Emotion-Classification
Wav2Small
SenseVoiceSmall
LIGHT-SERNET
21. SPEECHBRAIN WAV2VEC2

Official pretrained model exists.

Approximate size:

~380 MB FP32

Four classes:

anger
happiness
sadness
neutrality

Accuracy reported:

78.7% IEMOCAP

License:

CC-BY 4.0

Problem:

very large
ONNX export is not straightforward
poor fit for competition APK size

Decision:

REJECTED FOR V5B
22. SPEECHBRAIN ECAPA-TDNN

The official SpeechBrain IEMOCAP emotion recipe uses a smaller ECAPA-TDNN
architecture and 80-mel FBank input.

Desired labels:

anger
happiness
sadness
neutral

It fits the intended architecture extremely well.

However:

NO OFFICIAL PRETRAINED EMOTION CHECKPOINT WAS FOUND

Therefore it would require:

IEMOCAP
 ↓
SpeechBrain training
 ↓
trained ECAPA checkpoint
 ↓
ONNX export
 ↓
Android

This requires GPU/training infrastructure and IEMOCAP access.

Decision:

POSTPONED
23. DISTILHUBERT EMOTION

Investigated as another small mobile-oriented candidate.

Reported properties include:

~23 MB quantized
16 kHz
4 emotion classes

However:

no usable pretrained checkpoint was verified
license was unclear

Decision:

REJECTED / NOT READY
24. DPNGTM WAV2VEC2 EMOTION MODEL

This became the strongest downloadable candidate during research.

Verified artifact:

Architecture:
wav2vec2-base

Parameters:
~94.6M

FP32:
~360-378 MB

7 classes:
angry
calm
disgust
fearful
happy
sad
surprised

The model has:

16 kHz
raw waveform input

and a pretrained checkpoint exists.

ONNX export was successfully tested externally:

FP32 ONNX:
361.0 MB

INT8 ONNX:
116.9 MB

PyTorch vs ONNX:

class agreement:
YES

max absolute difference:
0.00000191

FP32 vs INT8:

class agreement:
YES

max logit difference:
0.0852
25. WHY DPNGTM WAS REJECTED

Despite working technically, it was rejected for the competition APK.

License uncertainty

The repository claims MIT through metadata, but:

LICENSE file:
NOT PRESENT

Therefore redistribution rights were not independently verified.

Label mismatch

The actual model classes are:

angry
calm
disgust
fearful
happy
sad
surprised

Only:

angry
happy
sad

map directly.

Mapping:

calm → neutral
disgust → neutral
fearful → neutral
surprised → happy

would introduce unverified semantic assumptions.

Do not present those mappings as true emotional classifications.

Model size

Even after INT8 quantization:

116.9 MB

which is substantial.

Combined runtime memory was estimated around:

200–300 MB

depending on the STT/model configuration.

26. FINAL V5B DECISION

V5B is:

POSTPONED

Do NOT implement an emotion model at this time.

Reason:

No currently verified model satisfies all required conditions simultaneously:

pretrained
+
small
+
clear license
+
offline
+
Android-friendly
+
ONNX compatible
+
appropriate emotion classes

The emotion field therefore remains:

emotion = "neutral"
emotionConfidence = 0.0

until a proper model is obtained.

27. IMPORTANT PRINCIPLE FOR V5B

Do NOT compromise the communication system merely to add emotion.

Emotion is a metadata enhancement.

The core system is:

Mic
 ↓
DPDFNet2
 ↓
STT
 ↓
SemanticMessage
 ↓
BLE
 ↓
SemanticMessage
 ↓
TTS

Emotion is optional:

                    ┌──→ emotion
enhanced PCM ───────┤
                    └──→ STT

If emotion is unavailable, communication must still work.

28. CURRENT PROJECT STATUS
V1  BLE Discovery
✅

V2  BLE GATT + HELLO
✅

V3  Speech → BLE → Speech
✅

V4  Semantic Message Layer
✅

V5A DPDFNet2 Speech Enhancement
✅ Implemented and committed

V5B Emotion Detection
⏸ Postponed
29. WHAT HAS NOT BEEN IMPLEMENTED YET

Still planned:

Emotion ML model
Binary semantic protocol
Message framing
Sequence numbers
ACK/NACK
Retries
Fragmentation
Encryption
BitChat-style mesh
Multi-hop relay
Voice/gender profile
Advanced multilingual processing

Do not accidentally treat the protocol plan document as implemented code.


The planned protocol includes concepts such as:

binary packet
24-byte header
message type
language
priority
message ID
sequence
sender/destination IDs
fragmentation
reassembly
ACK/NACK
encryption

Current implementation status:

NOT IMPLEMENTED

The correct future layer is:

SemanticMessage
      ↓
Binary Protocol Packet
      ↓
BLE Transport

Do not replace SemanticMessage with the protocol.

The protocol should encode SemanticMessage.

31. BITCHAT FUTURE ARCHITECTURE

The future networking architecture should remain:

Speech / AI
    ↓
SemanticMessage
    ↓
Binary Protocol
    ↓
Transport abstraction
    ↓
BLE / BitChat Mesh

The current BLE transport should eventually be replaceable by a BitChat-style
multi-hop transport without rewriting:

STT
DPDFNet2
SemanticMessage
TTS
UI

Future conceptual topology:

Phone A
  ↓
Relay 1
  ↓
Relay 2
  ↓
Relay 3
  ↓
Phone B
32. NEXT MILESTONE

The next development milestone should be:

V6 — Binary Semantic Protocol / Message Framing

Purpose:

Replace current JSON BLE payloads with a compact protocol layer.

Conceptually:

STT
 ↓
SemanticMessage
 ↓
Binary Packet
 ↓
BLE

Potential responsibilities:

packet header
message type
sequence number
packet/message ID
payload length
fragmentation metadata
reassembly preparation

Do NOT immediately combine:

encryption
ACK/retry
mesh routing

into one giant task.

Implement one layer at a time.

33. NEXT SESSION STARTING POINT

When continuing:

Verify Git branch is clean.
Confirm latest commit is ce6e85d.
Do NOT modify V5A unless physical testing reveals a problem.
Keep DPDFNet2 stable.
Keep SemanticMessage stable.
Do not resume emotion implementation unless a better legitimate model is
found.
Begin V6 protocol work.

Suggested first V6 architecture:

SemanticMessage
      ↓
SemanticPacket
      ↓
ProtocolCodec
      ↓
BLE transport

BLE should remain unaware of semantic meaning.

34. PHYSICAL TESTING CHECKLIST FOR COLLABORATOR

Before declaring V5A complete, test on physical Android devices:

DPDFNet2
 APK builds
 model loads from assets
 no crash at model initialization
 clean speech still transcribes
 noisy speech transcribes better or at least does not regress badly
 average DPDFNet inference time is measured
 first-utterance startup delay is measured
 repeated PTT does not leak resources
 no obvious audio discontinuity
 no severe CPU/thermal issue
STT
 Vosk English works
 IndicConformer Hindi works
 IndicConformer Bengali works
 VAD still behaves correctly
 no empty-input issues
 final transcripts remain reliable
BLE Voice Mode
 Phone A → Phone B works
 reverse direction works
 semantic message is delivered
 TTS works on receiver
 microphone mute prevents feedback loop
 disconnect behavior remains correct
End-to-end
Phone A:
Microphone
→ DPDFNet2
→ STT
→ SemanticMessage
→ BLE

Phone B:
BLE
→ SemanticMessage
→ TTS
→ Speaker
35. PHYSICAL TESTING FOR FUTURE PROTOCOL WORK

After this is implemented, physical testing must additionally verify:

small packet transmission
large packet handling
fragmentation
sequencing
dropped packet behavior
duplicate packet handling
reconnect behavior
multiple messages
message ordering
ACK/NACK behavior
