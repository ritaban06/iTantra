import numpy as np
import librosa
import os

SR = 16000
N_FFT = 512
N_MELS = 80
FMIN = 0
FMAX = 8000

# librosa's Slaney-normalized Mel filterbank
mel_filterbank = librosa.filters.mel(
    sr=SR,
    n_fft=N_FFT,
    n_mels=N_MELS,
    fmin=FMIN,
    fmax=FMAX,
    norm="slaney",
)

print(mel_filterbank.shape) # (80, 257)

# Ensure directory exists
out_dir = "../android/app/src/main/assets/audio"
os.makedirs(out_dir, exist_ok=True)
out_path = os.path.join(out_dir, "mel_filters_80x257.bin")

mel_filterbank.astype(np.float32).tofile(out_path)
print(f"Created {out_path}")
