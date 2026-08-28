This branch contains my work on the **speech enhancement / noise reduction
stage** of the iTantra project.

My objective was to investigate whether an offline neural speech-enhancement
model can reduce background noise while preserving the actual speech signal
well enough for the downstream Speech-to-Text (STT) system.

The work in this branch focuses specifically on:

- DeepFilterNet3
- Offline processing
- Noise reduction
- Speech enhancement
- Audio preprocessing
- Rust/libDF integration
- Python/PyO3 integration
- Google Colab execution
- Raw vs enhanced audio comparison

This branch **does not implement the complete iTantra communication system**.

The output of my module is an enhanced WAV file that can be passed to the
next stage of the project, such as STT.

---

# 1. where I can add deepfilternet 3

The overall iTantra concept is:

```text
Microphone
    ↓
Audio Capture
    ↓
Speech Enhancement
    ↓
VAD / STT
    ↓
Semantic Message
    ↓
Binary Encoding
    ↓
BLE / Mesh Transport
    ↓
Binary Decoding
    ↓
Semantic Message
    ↓
TTS
    ↓
Speaker

My contribution is the Speech Enhancement stage:

Input Speech
      ↓
Audio Preprocessing
      ↓
DeepFilterNet3
      ↓
Enhanced Speech
      ↓
STT Team

Therefore, my module should be treated as an upstream component of the speech-processing pipeline.


---

# 2. What I Have Actually Implemented

The current implementation performs the following:

Audio File
    ↓
Upload to Google Colab
    ↓
FFmpeg preprocessing
    ↓
48 kHz
Mono
16-bit PCM WAV
    ↓
DeepFilterNet3
    ↓
Noise Reduction
    ↓
Speech Enhancement
    ↓
Enhanced WAV

The important point is:

> I implemented the audio enhancement stage, not STT or the complete communication system.



The README and notebook intentionally keep the enhancement module separate from the STT, BLE and TTS modules.


---

3. Current Working Pipeline

The current tested pipeline is:

INPUT AUDIO
                     │
                     ▼
              Audio Upload
                     │
                     ▼
                FFmpeg
                     │
                     ▼
              48 kHz Mono
              16-bit PCM WAV
                     │
                     ▼
              DeepFilterNet3
                     │
                     ▼
             Enhanced Speech
                     │
                     ▼
              Enhanced WAV
                     │
                     ▼
             Future STT Module

The input and output are both local files during this experiment.

No cloud speech API is required for the enhancement process.


---

4. What Is DeepFilterNet3?

DeepFilterNet is a neural-network-based speech enhancement system designed for real-time capable speech enhancement.

The implementation used in this branch is based on DeepFilterNet3.

The DeepFilterNet project consists of Python components for controlling the inference process and native Rust components for audio processing.

Conceptually:

DeepFilterNet
     │
     ├── Python inference
     │
     └── libDF
           │
           └── Native Rust processing

Python controls the enhancement pipeline while libDF provides native audio-processing functionality.


---

5. Why I Chose DeepFilterNet3

I chose DeepFilterNet3 because the project requires an offline speech enhancement solution and the model is specifically designed for speech enhancement rather than generic audio filtering.

The goal was not simply to make the waveform quieter.

The goal was:

Noisy speech
     ↓
Remove/reduce unwanted background components
     ↓
Preserve speech
     ↓
Produce audio suitable for STT

For iTantra, this distinction is important because:

> Better sounding audio does not automatically mean better STT accuracy.



Therefore, the enhancement stage should ultimately be evaluated together with the STT stage.


---

6. Important Limitation of My Current Work

My current implementation is a Colab/offline experiment.

It is not yet the final Android implementation.

The current environment is:

Python
Rust
PyO3
Maturin
libDF
DeepFilterNet3
FFmpeg
Google Colab
CPU

The current input/output processing uses:

48 kHz
Mono
16-bit PCM WAV

Therefore, this branch should not be described as:

> "DeepFilterNet3 is already running inside the Android application."



That has not been established by this branch.


---

7. Environment

The working DeepFilterNet3 experiment uses:

Python 3.12
PyTorch 2.3.1
TorchAudio 2.3.1
NumPy 1.26.4
Maturin 1.4.0
PyO3 0.20.x
Rust
DeepFilterNet source
libDF

The Python environment is isolated using:

/content/dfenv

The Python executable is:

/content/dfenv/bin/python

The pip executable is:

/content/dfenv/bin/pip


---

8. Why Python 3.12 Is Required

One of the main problems encountered during development was the Python version compatibility between Colab, PyO3 and DeepFilterNet.

The PyO3 version used by the project supports Python up to version 3.12.

When Python 3.13 was used, the build produced an error similar to:

the configured Python interpreter version (3.13)
is newer than PyO3's maximum supported version (3.12)

Therefore, the working setup explicitly uses Python 3.12.

Important:

Python 3.12
      ↓
PyO3 0.20.x
      ↓
pyDF
      ↓
libDF

Do not casually change the Python version without retesting the complete build.


---

9. Rust / libDF

DeepFilterNet uses the native libDF component.

The Rust project is located inside the DeepFilterNet source tree.

Conceptually:

Python
  ↓
PyO3
  ↓
pyDF
  ↓
libDF
  ↓
Native audio processing

Rust is therefore required for building the native component used by the Python inference pipeline.


---

10. Maturin

Maturin is used to build the Python wheel containing the native Python/Rust extension.

The general process is:

Rust source
    ↓
Cargo
    ↓
pyDF
    ↓
Maturin
    ↓
Python wheel
    ↓
Install into Python 3.12 environment

The generated wheel is a build artifact and should not normally be committed to the repository.


---

11. Important Environment Variables

The build explicitly selects Python 3.12 using:

PYO3_PYTHON
PYTHON_SYS_EXECUTABLE

Both point to:

/usr/bin/python3.12

These variables prevent the build system from accidentally selecting Colab's Python 3.13 interpreter.


---

12. PYTHONPATH

DeepFilterNet's Python package must be visible to the interpreter.

The required path is:

/content/DeepFilterNet/DeepFilterNet

Therefore, the execution environment adds this directory to PYTHONPATH.

Without this, the Python process can produce:

ModuleNotFoundError: No module named 'df'

Therefore, the PYTHONPATH configuration should not be removed without checking the complete execution path.


---

13. Input Audio

The experiment accepts an uploaded audio recording.

The original test recording was approximately:

Sample rate: 48000 Hz
Channels:    1
Duration:    ~19.15 seconds

The original input format can be different from WAV because FFmpeg is used for preprocessing.

For example:

OPUS

can be converted into the required WAV format.


---

14. Audio Preprocessing

Before DeepFilterNet3, FFmpeg converts the input into:

Sample rate: 48000 Hz
Channels:    1
Format:      16-bit PCM WAV

Conceptually:

Original Audio
      ↓
     FFmpeg
      ↓
48 kHz / Mono / PCM16
      ↓
DeepFilterNet3

The important FFmpeg parameters are:

-ar 48000
-ac 1
-sample_fmt s16

Meaning:

-ar 48000

sets the sample rate to 48,000 Hz.

-ac 1

converts the audio to mono.

-sample_fmt s16

uses signed 16-bit PCM.


---

15. DeepFilterNet3 Execution

The main enhancement script is:

DeepFilterNet/DeepFilterNet/df/enhance.py

The model is loaded by the DeepFilterNet pipeline.

The output is written to an output directory such as:

/content/enhanced

The resulting file follows the DeepFilterNet naming convention.

For the test recording, the enhanced output was generated successfully.


---

16. CPU Execution

During the successful experiment, DeepFilterNet reported:

Running on device cpu

Therefore, the current implementation should be described as:

> Successfully tested on CPU.



The project should not claim GPU acceleration merely because CUDA-enabled packages are installed.

GPU execution would require a separate benchmark and configuration.


---

17. Result of My Experiment

The complete enhancement pipeline was successfully executed:

Input Audio
     ↓
FFmpeg
     ↓
48 kHz Mono WAV
     ↓
DeepFilterNet3
     ↓
Enhanced WAV

The output audio could be played back for comparison with the original recording.

Therefore, the core objective of this branch was successfully achieved:

> A noisy speech recording can be processed offline through DeepFilterNet3 and an enhanced WAV file can be generated.




---

18. Raw vs Enhanced Audio

The notebook allows comparison between:

RAW AUDIO

and:

DEEPFILTERNET3 ENHANCED AUDIO

The purpose of this comparison is to determine whether background noise has been reduced while speech remains understandable.

However, listening alone is not sufficient to decide whether the enhancement is useful for iTantra.

The important downstream question is:

Does enhancement improve STT?


---

19. Important Observation

One important observation from the experiment is:

Audio quality improvement
          ≠
Guaranteed STT improvement

A noise suppressor can make audio sound cleaner to a human while accidentally removing speech information that an STT model needs.

Therefore, the correct evaluation is:

Raw Audio
    ↓
STT
    ↓
Transcript A


Enhanced Audio
    ↓
STT
    ↓
Transcript B

Then compare the results.


---

20. STT Experiments After the Enhancement Work

After the initial enhancement experiment, I also separately experimented with speech recognition to understand how noise suppression affects transcription.

These experiments were exploratory and are not part of the current DeepFilterNet3 branch implementation.

I tested:

Whisper
RNNoise
Vosk

The purpose was to investigate:

Noise removal
     ↓
Speech preservation
     ↓
STT accuracy

These experiments should not be confused with the official DeepFilterNet3 module.


---

21. RNNoise Experiment

I also tested RNNoise as an alternative noise-suppression approach.

The result showed that RNNoise could reduce background noise, but in my test configuration it could also distort/remove speech information.

For example, the original speech contained a sentence similar to:

Hello, hello. Wake up to reality...

while the processed version produced a much poorer STT result.

This demonstrated an important lesson:

> Stronger noise suppression is not necessarily better speech enhancement.



For iTantra, preserving speech intelligibility is more important than simply maximizing noise reduction.


---

22. Vosk Experiment

I then started testing Vosk as an offline STT option.

The intended experiment is:

Original Audio
       ↓
      Vosk
       ↓
Original Transcript


Enhanced Audio
       ↓
      Vosk
       ↓
Enhanced Transcript

The purpose is to compare the STT performance using the same recognition model.

This is a separate experiment from the DeepFilterNet3 implementation.


---

23. DeepFilterNet3 vs DPDFNet2

There is an important distinction between my work and the Android team's implementation.

My branch uses:

DeepFilterNet3
Python
Rust/libDF
48 kHz
Colab

The Android implementation described by the team uses:

DPDFNet2
ONNX Runtime
16 kHz
Kotlin
Android

These are different models and different runtimes.

Therefore:

> DeepFilterNet3 and DPDFNet2 should not be treated as the same implementation.




---

24. Is DeepFilterNet3 Better Than DPDFNet2?

I do not want to claim that DeepFilterNet3 is automatically better for Android.

There are multiple criteria:

Speech quality
STT accuracy
Model size
RAM usage
CPU usage
Latency
Real-Time Factor
Battery consumption
Android compatibility

A model can produce better sounding audio but still be worse for a low-power Android device if it requires significantly more computation.

Therefore, the correct approach is to benchmark both.


---

25. Proposed DPDFNet2 vs DeepFilterNet3 Test

The same noisy speech dataset should be processed through both systems.

Conceptually:

SAME AUDIO
                         │
             ┌───────────┴───────────┐
             │                       │
             ▼                       ▼
        DeepFilterNet3           DPDFNet2
             │                       │
             ▼                       ▼
      Enhanced Audio A        Enhanced Audio B
             │                       │
             └───────────┬───────────┘
                         ▼
                     Same STT
                         │
                  ┌──────┴──────┐
                  ▼             ▼
              Result A       Result B

The comparison should measure:

Speech quality

Does the enhanced speech sound clearer?

STT accuracy

Does the STT transcription improve?

Latency

How long does enhancement take?

Real-Time Factor

Can the model process audio faster than real time?

CPU

How much CPU is required?

RAM

How much memory is required?

Model size

How large is the deployed model?

Only after these measurements should the team decide which enhancement model is better for the Android implementation.


---

26. Important Question

My current DeepFilterNet3 experiment runs at 48 kHz.

The Android pipeline described by the team currently operates at 16 kHz.

Therefore, before replacing DPDFNet2 with DeepFilterNet3, we need to answer:

> Does the Android DeepFilterNet3 implementation need 48-kHz microphone capture, or can the required processing be adapted efficiently while maintaining acceptable quality and latency?



Simply upsampling 16-kHz audio to 48 kHz does not recreate information that was never captured.

This needs to be tested rather than assumed.


---

27. Questions I Need to Confirm

The following questions are important before integrating my work into the Android application.

Android model

1. Is DPDFNet2 currently running successfully on a physical Android phone?


2. What exact DPDFNet2 model/checkpoint was used?


3. What is the exact model size?


4. What is the RAM usage during inference?


5. What is the CPU usage?


6. What is the measured inference latency?


7. What is the measured Real-Time Factor?




---

Audio pipeline

8. Why was 16 kHz selected for the Android pipeline?


9. Does the current STT model require 16 kHz?


10. Does the current DPDFNet2 model require 16 kHz?


11. What happens to the audio if the enhancement model fails?


12. Is the enhancement processing truly streaming on Android?


13. Is the model state correctly preserved between frames?


14. Is the state reset between separate PTT utterances?




---

STT

15. Which exact STT model is currently being used?


16. Is it completely offline?


17. What languages are currently supported by the actual STT implementation?


18. Has raw-vs-enhanced WER been measured?


19. Has STT accuracy been tested in noisy environments?


20. Does enhancement actually improve STT accuracy?




---

BLE


21. Is multi-hop forwarding implemented or only planned?


22. What is the actual negotiated BLE MTU?


23.. Is fragmentation implemented if the negotiated payload is smaller than the semantic packet?




---

TTS

24. Which offline TTS engine is currently being used?


25. Is TTS working on physical Android devices?


26. Which of the ten required languages have actually been tested?


27. Is the received language used to select the TTS voice?




---

Emotion

28. Is emotion recognition currently implemented?

29. Can you again tell me which model is used?

30. Is emotion = neutral currently just a placeholder?

---

31. What Is NOT Implemented in My Branch

The following are intentionally outside this branch:

[ ] Vosk integration
[ ] Whisper integration
[ ] STT pipeline
[ ] VAD
[ ] Word Error Rate evaluation
[ ] Emotion classification
[ ] Speaker identification
[ ] Voice-profile detection
[ ] SemanticMessage
[ ] Binary protocol
[ ] BLE transport
[ ] BLE mesh routing
[ ] TTS
[ ] Android application integration
[ ] End-to-end phone-to-phone communication

My module produces the enhanced audio that these downstream systems can consume.


---

29. Intended Integration

The intended integration is:

MY MODULE

Original Audio
      │
      ▼
DeepFilterNet3
      │
      ▼
Enhanced Audio
      │
      │
      ▼
                STT TEAM
                  │
                  ▼
                Text
                  │
                  ▼
             Semantic Layer
                  │
                  ▼
               BLE Mesh
                  │
                  ▼
                 TTS

The enhancement module should not need to know how BLE, semantic messages or TTS work.


---

30. Separation of Responsibilities

The project should maintain clear boundaries.

My module

Responsible for:

Audio
 ↓
Noise reduction
 ↓
Enhanced audio

STT module

Responsible for:

Enhanced audio
 ↓
Speech recognition
 ↓
Text

Semantic module

Responsible for:

Text
+
Language
+
Emotion
+
Voice profile
 ↓
SemanticMessage

Binary protocol

Responsible for:

SemanticMessage
 ↓
Compact bytes

BLE

Responsible for:

Bytes
 ↓
Transport
 ↓
Bytes

TTS

Responsible for:

Received semantic message
 ↓
Speech

This separation allows each component to be tested independently.


---

31. Files in My Contribution

The main work is represented by the DeepFilterNet notebook and documentation.

Important files include:

ML/
├── Noise_removal_deepfilternet.ipynb
├── Readme.md
└── ...

The notebook contains the installation, environment setup, build process, audio preprocessing and DeepFilterNet3 execution.


---

32. Runtime Files

The following files/directories are generated during the Colab experiment and should not be committed:

dfenv/
target/
*.so
*.whl
*.ckpt
temporary WAV files
enhanced audio files
private recordings

In particular:

/content/dfenv

and:

/content/DeepFilterNet/target

are runtime/build directories.


---

33. Audio Privacy

Real voice recordings may contain private conversations.

Therefore, personal recordings should not be committed to GitHub.

Do not commit:

WhatsApp voice messages
Personal OPUS recordings
Private WAV files
Generated versions of private recordings

Use synthetic or public-domain test recordings for reproducible examples.


---

34. Reproducibility

The notebook contains the setup steps intentionally.

A new Colab runtime does not preserve:

/content/dfenv
/content/DeepFilterNet
/content/enhanced

Therefore, the environment/build process may need to be repeated when starting a fresh runtime.

The expected workflow is:

1. Create Python 3.12 environment
2. Install dependencies
3. Install Rust
4. Clone DeepFilterNet
5. Build libDF
6. Build Python extension
7. Install wheel
8. Upload audio
9. Convert audio
10. Run DeepFilterNet3
11. Generate enhanced WAV
12. Listen to raw/enhanced audio
13. Pass enhanced audio to STT


---

35. Troubleshooting History

Python 3.13 / PyO3

Problem:

Python 3.13
+
PyO3 0.20.x

caused an incompatibility.

Solution:

Python 3.12


---

Maturin virtual environment problem

Maturin initially could not find an appropriate virtual environment.

Solution:

Use the isolated Python 3.12 environment and its Maturin installation.


---

libDF Python installation

An intermediate build produced an incomplete Python installation.

The solution was to build the proper Maturin wheel and install it into the Python 3.12 environment.


---

Missing df package

Problem:

ModuleNotFoundError:
No module named 'df'

Solution:

Set:

PYTHONPATH=/content/DeepFilterNet/DeepFilterNet


---

Missing Python dependencies

Missing runtime packages such as:

loguru
soundfile
librosa

were installed as part of the Python environment.


---

36. Current Status

Completed

[x] DeepFilterNet source setup
[x] Python 3.12 environment
[x] Rust setup
[x] PyO3 configuration
[x] Maturin configuration
[x] libDF compilation
[x] Python wheel generation
[x] libDF installation
[x] DeepFilterNet Python dependencies
[x] FFmpeg preprocessing
[x] OPUS input handling
[x] 48 kHz mono WAV conversion
[x] DeepFilterNet3 model loading
[x] Offline CPU enhancement
[x] Enhanced WAV generation
[x] RAW vs enhanced audio playback

Not completed in this branch

[ ] Android integration
[ ] Mobile benchmarking
[ ] DPDFNet2 vs DeepFilterNet3 benchmark
[ ] STT integration
[ ] Vosk integration
[ ] WER evaluation
[ ] VAD integration
[ ] BLE integration
[ ] Mesh routing
[ ] TTS integration
[ ] End-to-end Android test


---

37. What I Recommend We Do Next

The next step should not be immediately replacing DPDFNet2.

Instead, I recommend an objective comparison.

Step 1

Use the same noisy speech dataset.

Step 2

Generate:

Raw
DeepFilterNet3
DPDFNet2

versions.

Step 3

Run the same offline STT model on all three.

Raw → STT
DFN3 → STT
DPDFNet2 → STT

Step 4

Measure:

WER
Latency
CPU
RAM
Model size

Step 5

Test the best candidate on an actual Android phone.

Step 6

Only then decide whether DeepFilterNet3 should replace DPDFNet2.


---

38. Final Position of My Contribution

My contribution should be understood as:

> An offline DeepFilterNet3-based speech-enhancement experiment that successfully converts noisy speech into enhanced speech and provides a candidate preprocessing stage for the iTantra STT pipeline.



I am not claiming that DeepFilterNet3 is already proven superior to DPDFNet2 on Android.

That needs to be demonstrated through controlled benchmarking.

The important result from my work so far is that we now have a working offline neural speech-enhancement pipeline and a clear basis for comparing different enhancement approaches before integrating one into the Android application.


---

39. Questions / Decisions Required Before Integration

Before my module is integrated into the final Android pipeline, the team should confirm:

1. What exact DPDFNet2 model are we using?

2. Why was 16 kHz selected?

3. What STT model will consume the enhanced audio?

4. Does the STT model actually benefit from enhancement?

5. What is the measured WER for raw audio?

6. What is the measured WER after DPDFNet2?

7. What is the measured WER after DeepFilterNet3?

8. What are the CPU/RAM/latency measurements for both?

9. Can DeepFilterNet3 meet the low-power Android requirement?

10. Is multi-hop BLE already physically working?

11. Which languages are actually supported end-to-end?

12. Is emotion detection actually implemented or currently placeholder
    metadata?

13. Which offline TTS model is being used?

14. What is the measured end-to-end latency from speech to reconstructed
    speech?

15. Which enhancement model gives the best overall result for the SIH
    evaluation metrics?


---

40. Final Architecture

The final system should eventually look like:

SPEAKER
                    ▲
                    │
                   TTS
                    ▲
                    │
            SemanticMessage
                    ▲
                    │
             Binary Decoder
                    ▲
                    │
                 BLE Mesh
                    ▲
                    │
             Binary Encoder
                    ▲
                    │
            SemanticMessage
                    ▲
                    │
                   STT
                    ▲
                    │
           Enhanced Speech
                    ▲
                    │
              My Module
                    ▲
                    │
             DeepFilterNet3
                    ▲
                    │
             Audio Preprocess
                    ▲
                    │
               Microphone

My module therefore occupies this section:

Microphone
    ↓
Audio Preprocessing
    ↓
DeepFilterNet3
    ↓
Enhanced Speech
    ↓
STT

and its primary responsibility is:

> Improve speech quality while preserving the information required by downstream offline speech recognition.
