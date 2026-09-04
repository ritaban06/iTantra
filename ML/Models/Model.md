# Gender Classification Model
iTantra Project
This document records the complete technical information currently available for the voice gender-classification model developed for the iTantra project.
Current scope: This document covers the Gender Classification model. Information for STT, emotion detection, noise reduction, TTS, Bluetooth, mesh networking, or other ML models will be documented separately when those modules are finalized.
1. Model Identity
Model Name: Gender CNN v1 — Hindi Common Voice baseline
Task: Speech-based binary gender-label classification
Input: Hindi speech recording
Output classes:
Class ID
Label
0
male
1
female
The model uses acoustic information from speech represented as a log-Mel spectrogram and classifies the recording into the two training labels.
Important interpretation note
The model predicts the male/female voice-label categories represented in its training data. It should not be interpreted as determining a person's biological sex, gender identity, or any other personal attribute. Model predictions may be affected by speaker characteristics, recording conditions, microphone quality, background noise, accent, language, and differences between training and real-world audio.
2. Dataset
The model was trained using:
Mozilla Common Voice Scripted Speech 26.0 — Hindi
Dataset information
Dataset language: Hindi (hi)
Dataset format: MP3
Approximate dataset size: 545 MB
Approximate original clips: 19,029
Approximate original speakers: 480
Dataset license: CC0-1.0
Dataset source: Mozilla Data Collective
Dataset ID: cmqiod71900zgnr07uiyw57br
Dataset page:
https://mozilladatacollective.com/datasets/cmqiod71900zgnr07uiyw57br
The complete dataset is not included in this repository.
3. Gender Label Preparation
The original gender-related labels were mapped to the two model classes:
male_masculine  -> male
female_feminine -> female
Only recordings with usable gender labels were considered for this model.
4. Speaker-Level Data Splitting
A major part of the data preparation was preventing speaker leakage.
The dataset was split at the speaker level, rather than randomly splitting individual recordings.
This means recordings belonging to one speaker were kept within a single split.
This is important because the same speaker appearing in both training and testing can allow the model to learn speaker-specific characteristics and produce misleadingly high evaluation results.
Selected speakers
A total of 42 speakers were selected:
21 male
21 female
Speaker distribution
Split
Total Speakers
Male Speakers
Female Speakers
Train
29
15
14
Validation
6
3
3
Test
7
3
4
Total
42
21
21
Speaker overlap
The splits were checked to ensure that speakers did not overlap:
Train ∩ Validation = 0
Train ∩ Test       = 0
Validation ∩ Test  = 0
Therefore, the evaluation speakers are separate from the training speakers.
5. Recording Selection
A maximum of 50 recordings per speaker was used.
This was done to prevent speakers with a large number of recordings from dominating the dataset.
Final recording counts
Split
Total Recordings
Male
Female
Train
610
317
293
Validation
133
77
56
Test
146
37
109
Total
889
431
458
The final test set is not class-balanced. In particular, it contains substantially more female recordings than male recordings.
Therefore, accuracy alone should not be considered sufficient when evaluating this model.
6. Audio Preprocessing
The model expects speech to be converted into a consistent representation before inference.
6.1 Channel conversion
Input audio is converted to:
Mono
This removes differences caused by stereo channel configuration.
6.2 Sample rate
All audio is resampled to:
16,000 Hz
This is the sample rate used by the model's training preprocessing pipeline.
6.3 Fixed duration
Each sample is represented using:
4 seconds
Therefore:
16,000 samples/second × 4 seconds
= 64,000 samples
Longer recordings
For training:
Random 4-second crop
For validation and testing:
Center 4-second crop
The deterministic center crop is used for validation/test preprocessing so evaluation is reproducible.
Shorter recordings
Short recordings are:
Zero padded
until they reach the required 4-second length.
7. Audio Amplitude Normalization
The audio amplitude is normalized before feature extraction.
The preprocessing ensures that recordings with different raw amplitude levels do not unnecessarily dominate the feature representation.
8. Mel Spectrogram
The model does not directly process the raw waveform.
Instead, the waveform is converted into a Mel spectrogram.
The exact Mel-spectrogram configuration is:
n_mels     = 64
n_fft      = 1024
hop_length = 256
fmin       = 50 Hz
fmax       = 8000 Hz
Parameters
Parameter
Value
Sample rate
16,000 Hz
Mel bins
64
FFT size
1,024
Hop length
256
Minimum frequency
50 Hz
Maximum frequency
8,000 Hz
The Mel spectrogram represents the distribution of speech energy across perceptually motivated frequency bands over time.
9. Decibel Conversion
The Mel power spectrogram is converted into a logarithmic decibel representation using:
librosa.power_to_db
The resulting representation is referred to as the log-Mel spectrogram.
10. Log-Mel Normalization
The log-Mel values are normalized approximately to a 0–1 range using:
(log_mel + 80.0) / 80.0
This normalization is part of the feature-processing pipeline used for the model.
11. CNN Input Shape
After preprocessing, the model receives:
[batch, 1, 64, 251]
where:
batch   = number of audio samples processed together
1       = single input channel
64      = Mel-frequency bins
251     = time frames
The single channel is analogous to a grayscale image channel, allowing a 2D CNN to process the spectrogram.
12. Model Architecture
The trained model uses a custom convolutional neural network named:
GenderCNN
The architecture used during training is:
class GenderCNN(nn.Module):

    def __init__(self):
        super().__init__()

        self.features = nn.Sequential(
            nn.Conv2d(1, 16, kernel_size=3, padding=1),
            nn.BatchNorm2d(16),
            nn.ReLU(),
            nn.MaxPool2d(2),

            nn.Conv2d(16, 32, kernel_size=3, padding=1),
            nn.BatchNorm2d(32),
            nn.ReLU(),
            nn.MaxPool2d(2),

            nn.Conv2d(32, 64, kernel_size=3, padding=1),
            nn.BatchNorm2d(64),
            nn.ReLU(),
            nn.MaxPool2d(2),

            nn.Dropout(0.30)
        )

        self.pool = nn.AdaptiveAvgPool2d((1, 1))

        self.classifier = nn.Sequential(
            nn.Flatten(),
            nn.Linear(64, 32),
            nn.ReLU(),
            nn.Dropout(0.30),
            nn.Linear(32, 2)
        )

    def forward(self, x):
        x = self.features(x)
        x = self.pool(x)
        x = self.classifier(x)
        return x
13. Architecture Breakdown
Convolution block 1
Input channels: 1
Output channels: 16
Kernel: 3 × 3
Padding: 1
Batch Normalization
ReLU
MaxPool2d(2)
Purpose:
Detect low-level time-frequency patterns.
Reduce spatial dimensions using max pooling.
Convolution block 2
Input channels: 16
Output channels: 32
Kernel: 3 × 3
Padding: 1
Batch Normalization
ReLU
MaxPool2d(2)
Purpose:
Learn more complex spectrogram patterns.
Further reduce spatial dimensions.
Convolution block 3
Input channels: 32
Output channels: 64
Kernel: 3 × 3
Padding: 1
Batch Normalization
ReLU
MaxPool2d(2)
Purpose:
Learn higher-level acoustic patterns associated with the classification task.
Dropout
Dropout = 0.30
Dropout is used to reduce overfitting.
Adaptive Average Pooling
AdaptiveAvgPool2d((1, 1))
This converts the convolutional feature maps into a fixed-size representation.
The resulting feature vector contains:
64 features
Classifier
The classifier contains:
Linear: 64 → 32
ReLU
Dropout: 0.30
Linear: 32 → 2
The final layer produces two logits:
male
female
14. Complete Processing Pipeline
The complete model pipeline is:
Hindi speech recording
        ↓
Load audio
        ↓
Convert to mono
        ↓
Resample to 16 kHz
        ↓
4-second crop / zero padding
        ↓
Amplitude normalization
        ↓
Mel spectrogram
        ↓
64 Mel bins
        ↓
Power → dB
        ↓
Log-Mel normalization
        ↓
Tensor shape [1, 1, 64, 251]
        ↓
GenderCNN
        ↓
2 output logits
        ↓
Softmax
        ↓
Male / Female prediction
        +
Confidence score
15. Output
The model produces two class logits.
Softmax is applied to obtain class probabilities:
probabilities = torch.softmax(logits, dim=1)
The class with the highest probability is selected.
Example:
Prediction : male
Class ID   : 0
Confidence : 0.91
or:
Prediction : female
Class ID   : 1
Confidence : 0.87
The confidence value is the model's softmax output. It should not automatically be interpreted as a calibrated real-world probability.
16. Training Data Summary
Property
Value
Dataset
Common Voice Scripted Speech 26.0 — Hindi
Language
Hindi (hi)
Original clips
~19,029
Original speakers
~480
Selected speakers
42
Male speakers
21
Female speakers
21
Maximum recordings/speaker
50
Final recordings
889
Training recordings
610
Validation recordings
133
Test recordings
146
Sample rate
16 kHz
Channels
Mono
Duration
4 seconds
Mel bins
64
FFT size
1024
Hop length
256
Frequency range
50–8000 Hz
CNN input
[batch, 1, 64, 251]
Output classes
2
17. Speaker Leakage Protection
Speaker-level splitting is one of the important methodological decisions in this model.
A recording-level random split could place:
Speaker A recording 1 → training
Speaker A recording 2 → testing
This would allow the model to encounter the same speaker during training and evaluation.
Instead, this project uses:
Speaker A → Train only
Speaker B → Train only
Speaker C → Validation only
Speaker D → Test only
This provides a more meaningful test of generalization to unseen speakers.
18. Dataset Imbalance
The final test set contains:
Male   = 37 recordings
Female = 109 recordings
Therefore:
Male/Female test distribution is not balanced.
This should be considered when interpreting results.
Recommended future evaluation metrics:
Accuracy
Precision
Recall
F1-score
Confusion matrix
Per-class precision
Per-class recall
Per-class F1
Speaker-level evaluation
For a future production version, evaluation should also include a completely separate real-world Hindi speech test set.
19. Files Used for the Model Module
A clean repository implementation can use:
hindi-gender-cnn/
├── README.md
├── MODEL.md
├── requirements.txt
├── .gitignore
├── model.py
├── inference.py
└── models/
    └── gender_cnn_v1.pth
model.py
Contains the exact GenderCNN architecture.
inference.py
Contains:
audio loading
preprocessing
Mel-spectrogram generation
model loading
prediction
confidence calculation
command-line inference
models/gender_cnn_v1.pth
Contains the trained model checkpoint.
The actual checkpoint should be the trained weights produced by the training process. It should not be replaced with an unrelated pretrained model.
20. Runtime Requirements
The inference implementation requires Python and the following main packages:
PyTorch
NumPy
librosa
SoundFile
The exact runtime dependency versions should be pinned after the final deployment environment is decided.
A basic requirements file can contain:
numpy
librosa
soundfile
torch
For production deployment, exact versions should be recorded after compatibility testing.
21. Model Usage
Example Python usage:
from inference import GenderClassifier

classifier = GenderClassifier(
    model_path="models/gender_cnn_v1.pth"
)

result = classifier.predict("sample.wav")

print(result["label"])
print(result["confidence"])
Expected result format:
{
    "label": "male",
    "class_id": 0,
    "confidence": 0.91
}
22. Command-Line Usage
Example:
python inference.py --audio sample.wav
Using an explicit model:
python inference.py     --audio sample.wav     --model models/gender_cnn_v1.pth
23. Current Development Status
Status: Baseline model completed
The following parts have been completed for Gender CNN v1:
Hindi Common Voice dataset selected
Gender labels filtered
Gender labels mapped to male/female
Speaker IDs considered during splitting
Speaker-level train/validation/test split created
Speaker leakage checked
Maximum recording limit per speaker applied
Audio converted to a consistent representation
16 kHz sampling established
4-second fixed input established
Mel-spectrogram feature extraction established
Log-Mel normalization established
CNN architecture trained
Male/female output classes established
Trained model checkpoint produced
Model is prepared for integration as an isolated iTantra component
24. Known Limitations
This is a baseline model, not a universally reliable gender classifier.
Known considerations include:
The training dataset contains only a limited selected subset of speakers.
The test recordings are class-imbalanced.
The model was trained using scripted Common Voice speech.
Real-world recordings may contain different microphones and acoustic environments.
Background noise may affect predictions.
Accent and speaking style may affect predictions.
The model has only two output categories.
Softmax confidence is not necessarily calibrated.
Performance on languages other than Hindi has not been established.
Production performance should be validated on an independent real-world dataset.
25. Reproducibility Requirements
When retraining or reproducing this model, preserve:
Dataset:
  Common Voice Scripted Speech 26.0 — Hindi

Gender mapping:
  male_masculine  -> male
  female_feminine -> female

Speakers:
  42 total
  21 male
  21 female

Speaker split:
  Train: 29
  Validation: 6
  Test: 7

Maximum recordings/speaker:
  50

Audio:
  Mono
  16 kHz
  4 seconds

Cropping:
  Training: random
  Validation/Test: center

Padding:
  Zero padding

Mel:
  n_mels=64
  n_fft=1024
  hop_length=256
  fmin=50
  fmax=8000

Normalization:
  (log_mel + 80.0) / 80.0

CNN input:
  [batch, 1, 64, 251]

Classes:
  0 = male
  1 = female
The exact model architecture must also remain unchanged when loading the existing checkpoint.
26. Future Improvements
Possible future work for this module includes:
More Hindi speakers
More balanced recordings
More diverse recording conditions
Independent real-world evaluation
Cross-speaker validation
Cross-device evaluation
Class-wise metrics
Calibration of confidence scores
Robustness testing with background noise
Comparison with stronger speech-embedding models
Model quantization for edge/mobile deployment
Model versioning
Any future model should receive a new model version rather than silently replacing the current baseline.
Example:
Gender CNN v1
Gender CNN v2
Gender CNN v3
27. Separation From Other iTantra Modules
This model is intentionally maintained as a separate module.
The current Gender Classification module does not contain:
STT
Whisper
Vosk
Emotion Detection
DeepFilterNet
Noise Reduction
TTS
Bluetooth
Mesh Networking
UI
Other ML models
Those components will be documented independently when their implementations are finalized.
28. Model Versioning
Current model:
Gender CNN v1
Dataset baseline:
Mozilla Common Voice Scripted Speech 26.0 — Hindi
Future model versions should document:
Dataset changes
Speaker count
Recording count
Preprocessing changes
Architecture changes
Training configuration
Evaluation results
Known limitations
Checkpoint identifier
This document should be updated whenever a new Gender CNN version is officially released.
29. Summary
Gender CNN v1 — Hindi Common Voice baseline is a two-class CNN model designed to classify Hindi speech recordings into the training labels male and female.
The model uses speaker-level data splitting to reduce speaker leakage, standardized 16 kHz mono 4-second audio preprocessing, 64-bin log-Mel spectrogram features, and a compact CNN architecture.
The current implementation is a baseline for the iTantra project's gender-classification component. Other iTantra models and subsystems are intentionally outside the scope of this document.
