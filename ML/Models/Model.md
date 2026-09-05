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



# Voice Emotion Classification Model
iTantra Project

Current scope: This document covers only the speech-emotion classification model. Information for gender classification, STT, noise reduction, TTS, Bluetooth, mesh networking, UI, or other iTantra components is intentionally outside the scope of this document.

1. Model Identity
   
Project: iTantra
Model family: EmotionCNN
Documented versions:
EmotionCNN V1 — baseline
EmotionCNN V2 — improved model
Task: Seven-class speech emotion classification
Input: English speech recording
Output classes:
Class ID
Emotion
0 - angry
1 - disgust
2 - fear
3 - happy
4 - neutral
5 - sad
6- surprise

The model learns acoustic patterns from speech and predicts one of the seven emotion categories represented in the training taxonomy.
Important interpretation note
Speech emotion classification is inherently uncertain. A model prediction represents the emotion category inferred from the acoustic characteristics of the recording; it should not be interpreted as definitive proof of a person's actual emotional state.
Predictions can be affected by speaker characteristics, acting style, recording environment, microphone quality, background noise, speaking style, accent, emotional intensity, and differences between the training datasets and real-world speech.
3. Datasets
Three English speech-emotion datasets were used in the final training dataset:
CREMA-D
RAVDESS
TESS
SAVEE was investigated during the project but was not included in the final training dataset because direct dataset acquisition was unavailable/problematic during the project workflow.
4. CREMA-D
Dataset: CREMA-D
A total of:
7,442 WAV recordings
were obtained.
The emotion categories used from CREMA-D were:
angry, disgust, fear, happy, neutral, sad
CREMA-D does not provide the surprise class in the final metadata used for this seven-class model.
Final CREMA-D counts
Emotion
Recordings
angry - 1,271
disgust - 1,271
fear - 1,271
happy- 1,271
neutral - 1,087
sad- 1,271
surprise -0
Total - 7,442
5. RAVDESS
Dataset: RAVDESS
A total of: 1,440 speech recordings
were used before applying the target emotion taxonomy.
RAVDESS emotion codes were mapped as follows:
RAVDESS Code
Target Emotion
01 neutral
03 happy
04 sad
05 angry
06 fear
07 disgust
08 surprise
Emotion code 02 corresponds to calm and was intentionally excluded because calm is not part of the seven-class target taxonomy.
After excluding calm, the final RAVDESS contribution was:
1,248 recordings
Final RAVDESS counts Emotion Recordings
angry - 192
disgust - 192
fear-  192
happy - 192
neutral - 96
sad - 192
surprise - 192
Total - 1,248
6. TESS
Dataset: TESS
The original TESS download contained: 5,600 WAV files
An MD5 analysis identified: 2,800 duplicated recordings
The duplicated audio was removed.
Final unique TESS recordings: 2,800
Seven emotion categories were used: angry, disgust, fear,happy, neutral, sad, surprise
Each emotion contributed: 400 recordings
Final TESS counts Emotion Recordings
angry - 400
disgust - 400
fear - 400
happy - 400
neutral- 400
sad - 400
surprise - 400
Total - 2,800
7. SAVEE
SAVEE was investigated as a possible dataset during the project.
It was not included in the final training dataset because direct dataset acquisition was unavailable/problematic during the project workflow.
Therefore, SAVEE contributes: 0 recordings to the final master dataset.
8. Final Master Dataset
The final master dataset consists of: Dataset Recordings: CREMA-D - 7,442, RAVDESS - 1,248, TESS - 2,800, SAVEE - 0
Total - 11,490
The final metadata file is: emotion_metadata.csv
Metadata columns
filepath
dataset
speaker
emotion
Example schema:
Column
Meaning
filepath
Path to the audio recording
dataset
Source dataset
speaker
Speaker identifier
emotion
Target emotion label
The complete source datasets are not assumed to be included in the repository unless separately documented.
9. Dataset Distribution and Imbalance
The final master dataset contains 11,490 recordings from three datasets.
The distribution is not uniform across emotions and datasets.
An important reason is that:
CREMA-D contributes no surprise recordings to the final taxonomy.
RAVDESS contributes fewer neutral recordings than its other included emotions.
TESS contributes exactly 400 recordings for every emotion.
The datasets contain different speakers, recording conditions, speaking/acting styles, and acoustic characteristics.
Therefore, the combined dataset should be considered a multi-dataset, partially imbalanced emotion corpus rather than a perfectly balanced dataset.
10. Speaker-Level Data Splitting
A speaker-level split was used to reduce speaker leakage.
The data was divided by speaker rather than randomly assigning individual recordings to train, validation, and test sets.
Total speakers
129 speakers
Speaker distribution
Split
Speakers
Training
90
Validation
19
Test
20
Total
129
Recording distribution
Split
Recordings
Training
8,148
Validation
1,526
Test
1,816
Total
11,490
There was zero speaker overlap between:
Train ∩ Validation = 0
Train ∩ Test       = 0
Validation ∩ Test  = 0
11. Why Speaker-Level Splitting Was Used
A recording-level random split could allow recordings from the same speaker to appear in both training and testing.
For example:
Speaker A recording 1 → training
Speaker A recording 2 → testing
The model could then partially learn speaker-specific acoustic characteristics rather than general emotion-related patterns.
Instead, this project uses:
Speaker A → Train only
Speaker B → Validation only
Speaker C → Test only
This makes the held-out evaluation more representative of performance on speakers not encountered during training.
12. TESS Speaker Limitation
The overall dataset split is speaker-disjoint.
However, TESS contains only:
2 speakers
Therefore, TESS alone should not be interpreted as strong evidence of broad unseen-speaker generalization.
The model's generalization should be considered primarily in the context of the combined multi-dataset evaluation and the diversity of speakers represented across the complete dataset.
13. Audio Preprocessing
The model uses a standardized audio preprocessing pipeline.
The pipeline is:
Load audio
    ↓
Convert to mono
    ↓
Resample to 16,000 Hz
    ↓
Amplitude normalization
    ↓
Convert to exactly 4 seconds
    ↓
Mel spectrogram
    ↓
Convert to dB
    ↓
80 dB dynamic-range processing
    ↓
Log-Mel normalization
    ↓
CNN input
14. Channel Conversion
All input recordings are converted to:
Mono
This provides a consistent single-channel audio representation regardless of the original recording's channel configuration.
15. Sample Rate
All recordings are resampled to:
16,000 Hz
This is the sample rate used by the model's feature-extraction pipeline.
16. Fixed Audio Duration
Every model input is standardized to:
4 seconds
At 16 kHz:
16,000 samples/second × 4 seconds
= 64,000 samples
Therefore, each processed waveform contains:
64,000 samples
before spectrogram extraction.
17. Training-Time Cropping and Padding
Longer recordings
During training, recordings longer than four seconds use:
Random 4-second crop
Random cropping provides variation in the portions of the recordings seen during training.
Shorter recordings
Recordings shorter than four seconds are:
Zero padded
until they reach the required four-second duration.
18. Validation/Test Cropping
Validation and test preprocessing is deterministic.
For recordings longer than four seconds:
Center crop
is used.
For recordings shorter than four seconds:
Zero padding
is used.
This distinction is important:
Training:
    random crop

Validation/Test:
    deterministic center crop
The deterministic validation/test preprocessing avoids introducing random crop variation into benchmark results.
18. Audio Amplitude Normalization
Audio amplitude is normalized before feature extraction.
The purpose is to reduce unnecessary variation caused by different raw recording amplitudes.
The exact normalization implementation used in the training code should be preserved when reproducing the model.
19. Mel Spectrogram
The CNN operates on Mel-spectrogram features rather than directly on the raw waveform.
The configured parameters are:
Sample rate = 16,000 Hz
n_fft       = 1024
hop_length  = 256
n_mels      = 64
f_min       = 50 Hz
f_max       = 8,000 Hz
Feature parameters
Parameter
Value
Sample rate
16,000 Hz
FFT size (n_fft)
1,024
Hop length
256
Mel bins (n_mels)
64
Minimum frequency
50 Hz
Maximum frequency
8,000 Hz
20. Decibel Conversion
The Mel power spectrogram is converted to a logarithmic decibel representation.
The pipeline uses an:
80 dB dynamic range
The resulting representation is used as the log-Mel feature input to the CNN.
21. Log-Mel Normalization
The log-Mel values are normalized using:
(log_mel + 80) / 80
This maps the processed representation approximately into the range:
0–1
The same feature normalization must be used during inference.
22. Final Feature Shape
The final CNN input is:
[1, 64, 251]
For a batch, the corresponding tensor shape is:
[batch, 1, 64, 251]
where:
1   = single spectrogram channel
64  = Mel-frequency bins
251 = time frames
23. EmotionCNN V1 — Baseline
The first documented model is:
EmotionCNN V1
V1 was developed as the baseline model against which subsequent improvements were evaluated.
V1 input
1 × 64 × 251
V1 output
7 classes
The seven classes are:
angry
disgust
fear
happy
neutral
sad
surprise
24. V1 Architecture
The V1 model is a CNN-based classifier operating on log-Mel spectrograms.
The exact trained V1 architecture details beyond the documented parameter count and baseline configuration are:
[TO BE FILLED FROM THE ORIGINAL V1 TRAINING CODE]
Do not replace this placeholder with a newly designed architecture. The exact original V1 implementation should be used if the architecture needs to be reproduced.
25. V1 Parameter Count
106,343 parameters
26. V1 Training Configuration
Setting
Value
Optimizer
AdamW
Learning rate
0.001
Weight decay
1e-4
Loss
Weighted CrossEntropyLoss
Epochs
20
Scheduler
ReduceLROnPlateau
Scheduler factor
0.5
Scheduler patience
2
27. V1 Validation Result
Best V1 validation accuracy:
54.91%
This was used as the baseline validation result.
28. V1 Held-Out Test Result
V1 test accuracy:
57.49%
V1 test loss:
1.0820
The V1 test result was obtained on the held-out test set.
29. V1 Classification Report
The V1 held-out test classification report was:
Emotion
Precision
Recall
F1
Support
angry
0.6347
0.7167
0.6732
240
disgust
0.4585
0.3917
0.4225
240
fear
0.5115
0.3708
0.4300
240
happy
0.3410
0.4917
0.4027
240
neutral
0.4809
0.6300
0.5455
200
sad
0.7375
0.6386
0.6845
440
surprise
0.9266
0.7593
0.8346
216
Overall V1 results
Metric
Value
Accuracy
0.5749
Macro Precision
0.5844
Macro Recall
0.5712
Macro F1
0.5704
Weighted Precision
0.5990
Weighted Recall
0.5749
Weighted F1
0.5800
30. V1 Dataset-Wise Test Accuracy
The V1 held-out test accuracy by dataset was:
Dataset
Test Accuracy
CREMA-D
52.90%
RAVDESS
52.88%
TESS
73.75%
These values demonstrate that performance varies across datasets.
This is consistent with the presence of dataset-specific acoustic and recording characteristics.
31. V1 Baseline Findings
V1 demonstrated that the CNN could learn emotion-related acoustic patterns.
However, several classes were comparatively difficult.
The major V1 weaknesses were:
disgust
fear
happy
In particular, the V1 F1 scores for these classes were:
disgust → 0.4225
fear    → 0.4300
happy   → 0.4027
V1 was therefore treated as a baseline rather than the final model.
32. EmotionCNN V2 — Improved Model
The second documented model is:
EmotionCNN V2
V2 increases model capacity and introduces stronger training augmentation.
33. V2 Architecture
The documented V2 architecture is:
Input:
1 × 64 × 251

Convolution channels:
1 → 32
32 → 64
64 → 128
128 → 192

Batch Normalization
ReLU activations
Max pooling in convolutional blocks
Dropout2d = 0.20

Adaptive Average Pooling

Fully connected:
192 → 96

Dropout:
0.40

Output:
96 → 7
V2 parameter count
334,087 parameters
The architecture should remain consistent with the implementation used to create:
best_emotion_cnn_v2.pt
34. V2 Training Configuration
Setting
Value
Epochs
30
Optimizer
AdamW
Learning rate
0.0007
Weight decay
1e-4
Loss
Weighted CrossEntropyLoss
Scheduler
ReduceLROnPlateau
Scheduler factor
0.5
Scheduler patience
3
Gradient clipping
max_norm = 5.0
35. V2 Data Augmentation
V2 introduced stronger training-time augmentation.
The augmentation configuration was:
Random gain
Range: 0.75–1.25
Random time shift
Range: ±0.15 seconds
Gaussian noise
Gaussian noise was added to a subset of training examples.
Noise level:
0.001–0.008
Frequency masking
Width: 2–7
Probability: 50%
Time masking
Width: 5–24
Probability: 50%
These augmentations are training-time operations.
Validation and test preprocessing remains deterministic and does not use the random training augmentation pipeline.
36. V2 Training History
The recorded V2 training history is:
Epoch
Train Loss
Train Acc
Val Loss
Val Acc
LR
1
1.6480
29.71%
1.7853
23.33%
0.000700
2
1.3646
43.02%
2.4524
30.67%
0.000700
3
1.2443
48.61%
1.4273
39.71%
0.000700
4
1.1732
52.03%
2.2941
20.31%
0.000700
5
1.1279
53.74%
2.1161
27.98%
0.000700
6
1.0911
55.46%
2.3917
33.81%
0.000700
7
1.0457
57.08%
1.3911
46.53%
0.000700
8
1.0297
57.19%
2.0254
23.13%
0.000700
9
1.0083
58.59%
2.0372
30.80%
0.000700
10
0.9840
60.11%
1.4812
45.35%
0.000700
11
0.9801
60.15%
2.6684
27.39%
0.000350
12
0.9206
61.95%
1.1695
51.97%
0.000350
13
0.9025
63.00%
1.2594
50.92%
0.000350
14
0.8907
63.55%
2.0118
33.22%
0.000350
15
0.8880
62.76%
1.1588
55.24%
0.000350
16
0.8792
63.57%
1.4288
43.58%
0.000350
17
0.8749
64.02%
1.1313
56.42%
0.000350
18
0.8666
64.03%
1.2068
51.25%
0.000350
19
0.8612
64.85%
1.6887
43.58%
0.000350
20
0.8476
65.19%
1.3100
51.05%
0.000350
21
0.8420
65.34%
1.7278
40.63%
0.000175
22
0.8110
66.54%
1.5129
46.20%
0.000175
23
0.8102
67.17%
1.1732
53.87%
0.000175
24
0.7911
67.80%
1.1480
56.82%
0.000175
25
0.7942
66.83%
1.3031
49.34%
0.000175
26
0.7767
68.80%
1.1198
55.83%
0.000175
27
0.7744
67.78%
1.1682
56.36%
0.000175
28
0.7779
67.80%
1.2581
51.57%
0.000087
29
0.7567
68.09%
1.0987
58.85%
0.000087
30
0.7627
68.77%
1.1095
57.01%
0.000087
Learning-rate values are shown according to the recorded training history. The scheduler reduced the learning rate during training.
37. V2 Best Checkpoint
The best V2 checkpoint was obtained at:
Epoch: 29
Best validation accuracy:
58.85%
Best validation loss:
1.0987
Checkpoint:
best_emotion_cnn_v2.pt
The checkpoint represents the best V2 model according to the recorded validation accuracy.
38. V1 → V2 Comparison
Property
EmotionCNN V1
EmotionCNN V2
Parameters
106,343
334,087
Training epochs
20
30
Initial learning rate
0.001
0.0007
Weight decay
1e-4
1e-4
Loss
Weighted CrossEntropyLoss
Weighted CrossEntropyLoss
Scheduler
ReduceLROnPlateau
ReduceLROnPlateau
Best validation accuracy
54.91%
58.85%
Held-out test accuracy
57.49%
Pending
Validation improvement
The recorded validation improvement is:
58.85% - 54.91%
= 3.94 percentage points
This is a validation improvement only.
It must not be described as a confirmed improvement on the held-out test set until the V2 test benchmark is completed.
39. V2 Test Benchmark — Pending
The final held-out V2 test benchmark has not yet been completed/documented.
Therefore, the following V2 values are intentionally not reported:
V2 test accuracy
V2 test loss
V2 classification report
V2 confusion matrix
V2 per-emotion test precision
V2 per-emotion test recall
V2 per-emotion test F1
V2 dataset-wise test accuracy
These values should be added only after the held-out test set has been evaluated using the saved V2 checkpoint.
Required future benchmark
best_emotion_cnn_v2.pt
        ↓
Held-out test set
        ↓
Accuracy
        ↓
Loss
        ↓
Precision
        ↓
Recall
        ↓
F1-score
        ↓
Confusion matrix
        ↓
Per-emotion results
        ↓
Dataset-wise results
40. Benchmarking Methodology
Model evaluation should keep the following categories separate.
Training metrics
Metrics measured on the data used to train the model.
These describe optimization progress but do not represent generalization performance.
Validation metrics
Metrics measured on the validation speakers.
Validation performance was used to select the best V2 checkpoint.
Held-out test metrics
Metrics measured on the test speakers that were not used for training or model selection.
These should be used for final performance reporting.
Manual audio testing
Individual uploaded recordings can be used for qualitative sanity checks.
Manual examples should not be presented as formal benchmark results.
41. Manual Audio Testing
The model is also being tested manually by uploading individual audio recordings in Google Colab.
A manual inference run can return:
Predicted emotion
Confidence
Probability for angry
Probability for disgust
Probability for fear
Probability for happy
Probability for neutral
Probability for sad
Probability for surprise
Manual testing is useful for checking whether the inference pipeline works on individual recordings.
However:
Manual audio examples are qualitative sanity checks and do not replace evaluation on the held-out test set.
42. Intended Inference Pipeline
The intended inference pipeline is:
Input English speech
        ↓
Load audio
        ↓
Convert to mono
        ↓
Resample to 16 kHz
        ↓
Amplitude normalization
        ↓
4-second center crop / zero padding
        ↓
Mel spectrogram
        ↓
n_mels = 64
        ↓
n_fft = 1024
        ↓
hop_length = 256
        ↓
fmin = 50 Hz
        ↓
fmax = 8000 Hz
        ↓
Power → dB
        ↓
80 dB dynamic range
        ↓
(log_mel + 80) / 80
        ↓
Tensor [1, 64, 251]
        ↓
EmotionCNN V2
        ↓
7 logits
        ↓
Softmax
        ↓
Seven emotion probabilities
        ↓
Predicted emotion + confidence
43. Inference Output
The final model output consists of seven class logits.
Softmax can be used to obtain class probabilities:
probabilities = torch.softmax(logits, dim=1)
The highest-probability class can then be selected as the predicted emotion.
Example output format:
Prediction : happy
Class ID   : 3
Confidence : [MODEL OUTPUT]
The confidence value should be understood as the model's softmax score and should not automatically be interpreted as a calibrated probability.
44. Checkpoint
Current best V2 checkpoint:
best_emotion_cnn_v2.pt
The checkpoint was selected using:
Best validation accuracy
at:
Epoch 29
Validation accuracy = 58.85%
No file size or hash is documented here because those values were not provided.
45. Reproducibility
A reproducible implementation should preserve all of the following:
Dataset
CREMA-D
RAVDESS
TESS
SAVEE should not be added unless a new experiment explicitly documents it.
Metadata
emotion_metadata.csv
with:
filepath
dataset
speaker
emotion
Speaker split
129 total speakers

Train: 90
Validation: 19
Test: 20
with zero overlap.
Audio
Mono
16 kHz
4 seconds
64,000 waveform samples
Cropping
Training:
    Random 4-second crop

Validation/Test:
    Center crop
Padding
Zero padding
Mel features
n_mels = 64
n_fft = 1024
hop_length = 256
fmin = 50
fmax = 8000
Normalization
(log_mel + 80) / 80
CNN input
[batch, 1, 64, 251]
Classes
0 = angry
1 = disgust
2 = fear
3 = happy
4 = neutral
5 = sad
6 = surprise
