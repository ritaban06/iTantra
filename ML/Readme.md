
DeepFilterNet3 — Speech Enhancement / Noise Reduction

Overview:-

This module implements the speech enhancement / noise reduction stage of the project using DeepFilterNet3.

The purpose of this module is to take a noisy speech recording, reduce the background noise, and generate an enhanced speech recording that can later be passed to the project's Speech-to-Text (STT) module.

Current pipeline

INPUT AUDIO
                    │
                    ▼
             Audio Upload
                    │
                    ▼
             FFmpeg Conversion
                    │
                    │ 48 kHz
                    │ Mono
                    │ 16-bit PCM WAV
                    ▼
             DeepFilterNet3
                    │
                    │ Noise reduction
                    │ Speech enhancement
                    ▼
            ENHANCED AUDIO
                    │
                    ▼
             Future STT Module

> Important: This branch currently implements only the audio enhancement stage. STT, Whisper, Vosk, transcription comparison, and evaluation are intentionally kept outside this module.




---

 Objective:-

The objective of this module is to improve the quality of speech recordings before they are sent to a Speech-to-Text model.

The input can contain:

Background noise

Environmental sounds

Low-level interference

Recording artifacts

Other unwanted audio components


DeepFilterNet3 attempts to suppress these unwanted components while preserving the speech signal.

The output is an enhanced .wav file.


---

🧠 What is DeepFilterNet3?

DeepFilterNet is a neural-network-based speech enhancement system designed for real-time capable speech enhancement.

In this implementation, we are using the DeepFilterNet3 model provided through the DeepFilterNet repository.

The system consists of two important parts:

DeepFilterNet
     │
     ├── Python inference code
     │
     └── libDF
           │
           └── Native Rust audio processing library

The Python code controls the model and processing pipeline, while libDF provides native audio-processing functionality.


---

📂 Repository Structure

The relevant structure inside the downloaded DeepFilterNet repository is approximately:

DeepFilterNet/
│
├── DeepFilterNet/
│   └── df/
│       ├── enhance.py
│       ├── checkpoint.py
│       ├── model.py
│       ├── io.py
│       └── ...
│
├── pyDF/
│   ├── Cargo.toml
│   └── src/
│       └── lib.rs
│
├── libDF/
│   └── ...
│
└── target/
    └── ...

Important directories

DeepFilterNet/df/

Contains the Python implementation used for inference.

The main entry point used by this project is:

DeepFilterNet/DeepFilterNet/df/enhance.py

pyDF/

Contains the Rust/PyO3 Python bindings for libDF.

libDF/

Contains the native Rust audio-processing implementation.

target/

Generated during Rust compilation.

This directory is not something that should normally be committed to GitHub.


---

 Environment:-

The implementation uses an isolated Python environment.

Python

Python 3.12

The virtual environment is created at:

/content/dfenv

The Python executable used by the project is:

/content/dfenv/bin/python

The pip executable is:

/content/dfenv/bin/pip


---

❗ Why Python 3.12?

This is one of the most important setup details.

The version of DeepFilterNet used in this implementation contains:

PyO3 0.20.x

The PyO3 version used by the pyDF component supports Python versions up to 3.12.

Google Colab can use a newer system Python version. During development, attempting to build libDF with Python 3.13 produced:

error: the configured Python interpreter version (3.13)
is newer than PyO3's maximum supported version (3.12)

Therefore, this project explicitly uses:

/usr/bin/python3.12

for the virtual environment and Rust/PyO3 build.

Do not change this casually.

Changing the Python version can cause the libDF build to fail.


---

🦀 Rust Environment

Rust is required because libDF contains native Rust code.

The notebook installs Rust using rustup.

The important tools are:

rustc
cargo

Cargo is used to compile the native libDF component.


---

📦 Main Dependencies

The current environment uses the following important versions:

Component	Version

Python	3.12
PyTorch	2.3.1
TorchAudio	2.3.1
NumPy	1.26.4
Maturin	1.4.0
PyO3	0.20.x
DeepFilterNet	0.5.7 development/release candidate source
Rust	Current compatible Rust toolchain


The exact DeepFilterNet source checkout used during development reported:

DeepFilterNet 0.5.7rc0

and the pyDF package identifies itself as:

0.5.7-pre

These version strings come from the source revision being used.


---

🔧 Python Runtime Dependencies

The DeepFilterNet Python runtime requires:

loguru
soundfile
librosa

These are installed into the isolated environment.

They are required by the Python inference code.


---

🔥 PyTorch Configuration

The environment installs:

torch==2.3.1
torchaudio==2.3.1

using the CUDA 12.1 package index.

However, the fact that CUDA-enabled PyTorch packages are installed does not guarantee that DeepFilterNet will actually run on the GPU.

During our working test, DeepFilterNet reported:

Running on device cpu

Therefore, the current implementation should be considered CPU-compatible.

If GPU execution is required later, it should be handled as a separate optimization/configuration task rather than assumed from the installed PyTorch package.


---

🏗️ Building libDF

DeepFilterNet requires the native libDF component.

The Rust project is located at:

/content/DeepFilterNet/pyDF/Cargo.toml

The build is explicitly configured to use Python 3.12:

env["PYO3_PYTHON"] = "/usr/bin/python3.12"
env["PYTHON_SYS_EXECUTABLE"] = "/usr/bin/python3.12"

Then Cargo builds the native library:

cargo build --release

This successfully compiled the following components:

deep_filter
DeepFilterLib
pyDF


---

🐍 PyO3 and Maturin

pyDF uses PyO3 to expose Rust functionality to Python.

The project uses Maturin to build the Python wheel.

The important command conceptually is:

maturin build --release

with the Python 3.12 interpreter explicitly selected.

The resulting wheel is generated under:

DeepFilterNet/target/wheels/

The wheel is then installed into:

/content/dfenv

This makes the native libDF functionality available to Python.


---

⚙️ Important Environment Variables

The following environment variables are important during the native build:

PYO3_PYTHON
PYTHON_SYS_EXECUTABLE

Both are configured to:

/usr/bin/python3.12

PYO3_PYTHON

Tells PyO3 which Python interpreter should be used while compiling the extension.

PYTHON_SYS_EXECUTABLE

Ensures build tools use the same Python interpreter.

This prevents the build system from accidentally selecting Colab's system Python.


---

🐍 PYTHONPATH

When DeepFilterNet is executed, the notebook sets:

env["PYTHONPATH"] = (
    "/content/DeepFilterNet/DeepFilterNet"
    + ":"
    + env.get("PYTHONPATH", "")
)

This is important because the DeepFilterNet Python package contains the:

df

package.

Without the correct PYTHONPATH, the following error can occur:

ModuleNotFoundError: No module named 'df'

Therefore, do not remove the PYTHONPATH configuration from the enhancement execution cell.


---

🎙️ Input Audio

The notebook allows the user to upload an audio recording directly through Google Colab.

For example:

PTT-20260825-WA0002.opus

The original recording in our test had approximately:

Sample rate: 48000 Hz
Channels: 1
Duration: 19.15 seconds

The input format does not have to be WAV because FFmpeg is used for preprocessing.


---

🔄 Audio Preprocessing

The uploaded audio is converted using FFmpeg.

The target format is:

Sample rate: 48000 Hz
Channels: 1
Sample format: 16-bit PCM
Container: WAV

The resulting intermediate file is:

/content/ptt_raw_48k.wav

The important FFmpeg parameters are:

-ar 48000
-ac 1
-sample_fmt s16

Meaning

-ar 48000

48,000 Hz sample rate

-ac 1

Mono audio

-sample_fmt s16

16-bit signed PCM


---

🧹 DeepFilterNet3 Processing

The main inference script is:

/content/DeepFilterNet/DeepFilterNet/df/enhance.py

The Python environment executes:

enhance.py

with the input WAV file.

The output directory is:

/content/enhanced

The model is selected using:

--model-base-dir DeepFilterNet

DeepFilterNet then loads the pretrained DeepFilterNet3 model.

During our successful test, the model was loaded from:

/root/.cache/DeepFilterNet/DeepFilterNet

and DeepFilterNet reported:

Initializing model `deepfilternet`

followed by:

Model loaded


---

📤 Output

The generated enhanced file follows the DeepFilterNet naming convention.

For example:

/content/enhanced/ptt_raw_48k_DeepFilterNet.wav

The notebook then identifies the generated WAV file and stores its path in:

ENHANCED_WAV

The final enhanced audio can therefore be accessed through:

ENHANCED_WAV


---

🔤 Important Variables

These are the main variables used by the notebook.

Variable	Purpose

ENV_DIR	Location of Python virtual environment
PYTHON	Python executable used to run DeepFilterNet
PIP	pip executable for the isolated environment
REPO	DeepFilterNet repository location
PYTHON312	System Python 3.12 executable
CARGO_TOML	Rust/PyO3 package manifest
ENHANCE	DeepFilterNet enhancement script
INPUT_FILE	User-uploaded audio file
RAW_WAV	FFmpeg-converted input WAV
OUTPUT_DIR	Directory containing enhanced audio
ENHANCED_WAV	Final enhanced audio file
LIBDF_WHEEL	Maturin-generated Python wheel



---

📊 Current Test Result

We successfully processed a real speech recording through the complete pipeline.

Input

PTT-20260825-WA0002.opus

Converted input

ptt_raw_48k.wav

Output

ptt_raw_48k_DeepFilterNet.wav

DeepFilterNet3 successfully completed processing.

Example log:

Model loaded
Enhanced noisy audio file 'ptt_raw_48k.wav'

The processing completed successfully on CPU.


---

🎧 Before vs After

The notebook provides audio playback for both:

RAW AUDIO

and:

DEEPFILTERNET3 ENHANCED AUDIO

This allows the team to manually listen to the effect of noise reduction.

Important observation

Noise reduction does not automatically mean better STT transcription.

During testing, DeepFilterNet3 successfully reduced the signal energy, but the STT results did not necessarily improve.

Therefore:

Audio quality improvement
        ≠
Guaranteed STT accuracy improvement

This is an important reason why the STT module should evaluate raw vs enhanced audio separately.


---

🚫 What Is NOT Included

This branch intentionally does not contain:

Vosk STT

Whisper STT

Whisper Tiny

Speech transcription

Word Error Rate calculation

STT comparison

Audio classification

Speaker identification

Voice activity detection

Final application/UI integration


Those components can consume:

ENHANCED_WAV

as their input later.


---

🔗 Integration With STT

The intended integration is:

┌─────────────────────┐
                │   Original Audio    │
                └──────────┬──────────┘
                           │
                           ▼
                  ┌─────────────────┐
                  │  DeepFilterNet3 │
                  │  Noise Removal  │
                  └────────┬────────┘
                           │
                           ▼
                ┌─────────────────────┐
                │   Enhanced Audio    │
                └──────────┬──────────┘
                           │
                           ▼
                  ┌─────────────────┐
                  │    STT Module   │
                  │ Whisper / other │
                  └────────┬────────┘
                           │
                           ▼
                     Transcription

The DeepFilterNet module should therefore expose the enhanced audio path to the next module rather than performing STT itself.


---

📓 Google Colab Workflow

The notebook is designed for Google Colab.

The general order is:

1. Install Python 3.12
2. Install system dependencies
3. Install Rust
4. Create Python 3.12 virtual environment
5. Install Python dependencies
6. Clone DeepFilterNet
7. Build libDF
8. Build Python extension with Maturin
9. Install libDF wheel
10. Upload audio
11. Convert audio using FFmpeg
12. Run DeepFilterNet3
13. Locate enhanced WAV
14. Listen to RAW vs ENHANCED

Cells should generally be executed in this order.


---

⚠️ Important: Google Colab Environment

The notebook uses paths such as:

/content/dfenv
/content/DeepFilterNet
/content/enhanced

These are Colab runtime paths.

They are not permanent system directories.

When a new Colab runtime is created, the setup may need to be executed again.

Therefore, the notebook contains the installation/build steps intentionally.


---

🧪 Troubleshooting History

During development, several issues were encountered and resolved.

1. Python 3.13 / PyO3 incompatibility

Error:

configured Python interpreter version (3.13)
is newer than PyO3's maximum supported version (3.12)

Solution

Use:

Python 3.12

and explicitly set:

PYO3_PYTHON=/usr/bin/python3.12
PYTHON_SYS_EXECUTABLE=/usr/bin/python3.12


---

2. Maturin could not find virtualenv

Error:

Couldn't find a virtualenv or conda environment

Solution

Create:

/content/dfenv

and execute Maturin from:

/content/dfenv/bin/maturin

rather than relying on the system installation.


---

3. libdf.libdf import issue

An intermediate installation produced:

ModuleNotFoundError: No module named 'libdf.libdf'

The native extension existed, but the Python wrapper installation was incomplete.

Solution

Build the proper Maturin wheel and install that wheel into the Python 3.12 environment.


---

4. ModuleNotFoundError: No module named 'df'

DeepFilterNet initially could not find its Python package.

Solution

Set:

PYTHONPATH=/content/DeepFilterNet/DeepFilterNet

when running the enhancement process.


---

5. Missing loguru

Error:

ModuleNotFoundError: No module named 'loguru'

Solution

Install DeepFilterNet's runtime Python dependencies:

loguru
soundfile
librosa

These are now included in the main dependency setup rather than being treated as troubleshooting steps.


---

🧹 Files That Should NOT Be Committed

The following are generated/runtime files and should normally not be committed to the project repository:

dfenv/
target/
*.so
*.whl
*.ckpt
enhanced audio files
temporary WAV files
uploaded personal recordings
Colab temporary files

In particular, do not commit:

/content/dfenv

or the generated:

/content/DeepFilterNet/target

directory.

The notebook should reproduce these files when executed.


---

🔐 Audio Privacy

Uploaded recordings may contain private conversations or personal information.

Therefore:

Do not commit real user recordings.

Do not commit WhatsApp voice messages.

Do not commit personal .opus files.

Do not commit generated enhanced versions of private recordings.


Use synthetic/public test audio when test files need to be included in the repository.


---

📁 Recommended Project-Level Structure

Eventually, the project can be organized approximately like:

Project/
│
├── README.md
│
├── audio_enhancement/
│   ├── README.md
│   └── deepfilternet_noise_reduction.ipynb
│
├── stt/
│   └── ...
│
├── preprocessing/
│   └── ...
│
└── requirements/
    └── ...

The DeepFilterNet notebook should remain isolated from the STT implementation.


---

🚀 Future Improvements

The current implementation establishes the basic DeepFilterNet3 pipeline.

Possible future work:

1. Automatic STT evaluation

Compare:

Raw Audio → STT

against:

Enhanced Audio → STT

using the same STT model.


---

2. Objective audio evaluation

Add measurements such as:

SNR

SI-SDR

PESQ

STOI

Word Error Rate (WER)


These should be added as a separate evaluation module, not mixed into the core enhancement notebook.


---

3. GPU optimization

The current successful run reported:

Running on device cpu

Future work can investigate GPU execution for faster processing.


---

4. Integration into the main application

Eventually the notebook implementation can be converted into a reusable Python module/API:

enhanced_audio = enhance_audio(input_audio)

so that the main application does not depend on a Colab notebook.


---

✅ Current Status

DeepFilterNet module

Status: Working

The following have been successfully established:

[x] Python 3.12 environment

[x] Rust environment

[x] DeepFilterNet source

[x] libDF Rust compilation

[x] PyO3 integration

[x] Maturin wheel generation

[x] libDF Python installation

[x] DeepFilterNet Python dependencies

[x] OPUS input handling

[x] FFmpeg preprocessing

[x] 48 kHz mono WAV conversion

[x] DeepFilterNet3 model loading

[x] Noise enhancement

[x] Enhanced WAV generation

[x] RAW vs enhanced audio playback


Not yet part of this module

[ ] STT

[ ] Whisper integration

[ ] Vosk integration

[ ] Raw vs enhanced transcription comparison

[ ] WER evaluation

[ ] End-to-end application integration



---

👥 Team Integration

The output of this module should be treated as the input to the next processing stage.

Input

Audio recording

Output

Enhanced WAV audio

The STT team can use:

ENHANCED_WAV

or the generated enhanced .wav file as the input to their transcription pipeline.

This keeps the project modular:

Audio Enhancement
       ↓
Enhanced Audio
       ↓
Speech-to-Text
       ↓
Text Processing
       ↓
Final Application


---

📌 Important Notes for Contributors

1. Use Python 3.12 for this DeepFilterNet implementation.


2. Do not replace it with Python 3.13 without checking PyO3 compatibility.


3. Do not remove the PYO3_PYTHON configuration.


4. Do not remove the PYTHONPATH configuration from the DeepFilterNet execution.


5. Do not commit dfenv/.


6. Do not commit Cargo target/ files.


7. Do not commit generated .so or .whl files.


8. Do not commit private audio recordings.


9. Keep STT code separate from this module.


10. The enhanced audio should be passed to STT as the next pipeline stage.


11. GPU execution should not be assumed; the current verified run used CPU.


12. If dependency versions are changed, test the complete pipeline again.




---

📜 License / Attribution

This implementation uses the DeepFilterNet project and its associated libDF components.

Please retain and follow the original project's license and attribution requirements when redistributing or modifying the DeepFilterNet components.


---

🏁 Summary

This branch establishes the project's speech enhancement layer using DeepFilterNet3.

The complete working flow is:

User Audio
              │
              ▼
       Upload to Colab
              │
              ▼
           FFmpeg
              │
              ▼
      48 kHz Mono WAV
              │
              ▼
        DeepFilterNet3
              │
              ▼
      Enhanced Speech WAV
              │
              ▼
        Future STT Module

The primary responsibility of this module is therefore:

> Convert noisy speech into an enhanced speech recording that can be consumed by the project's downstream STT pipeline.




---

One thing I recommend before committing this README

Your current notebook has the correct working logic, but I would make one final cleanup before pushing it: move loguru, soundfile, and librosa into the main dependency-installation cell, as we discussed, and remove the separate late installation cell. Then your notebook + this README will tell exactly the same story.

For the GitHub branch, I'd use these two files:

feature/deepfilternet/
│
├── deepfilternet_noise_reduction.ipynb
└── README.md

That is a clean, understandable first contribu
