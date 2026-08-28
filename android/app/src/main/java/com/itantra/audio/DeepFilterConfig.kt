package com.itantra.audio

/**
 * Configuration constants for the DPDFNet2 streaming speech enhancement engine.
 *
 * All values are verified against the actual ONNX model graph:
 *   dpdfnet2.onnx — opset 17, 16 kHz, FP32
 *   Source: https://github.com/k2-fsa/sherpa-onnx/releases/download/speech-enhancement-models/dpdfnet2.onnx
 */
object DeepFilterConfig {

    /** Asset path for the ONNX model inside the APK. */
    const val MODEL_ASSET_PATH = "models/audio/dpdfnet2.onnx"

    /** Expected sample rate in Hz. */
    const val SAMPLE_RATE = 16000

    /** FFT size (also window length). Must equal n_fft used during model training. */
    const val FFT_SIZE = 320

    /** Number of samples the model advances per frame (hop length). */
    const val HOP_SIZE = 160

    /** Number of output frequency bins = FFT_SIZE / 2 + 1. */
    const val NUM_FREQ_BINS = FFT_SIZE / 2 + 1 // 161

    /** Size of the RNN/GRU hidden state vector carried between frames. */
    const val STATE_SIZE = 45424

    /** ONNX input tensor name for the complex STFT spectrum. */
    const val INPUT_SPEC_NAME = "spec"

    /** ONNX input tensor name for the RNN state. */
    const val INPUT_STATE_NAME = "state_in"

    /** ONNX output tensor name for the enhanced spectrum. */
    const val OUTPUT_SPEC_NAME = "spec_e"

    /** ONNX output tensor name for the updated RNN state. */
    const val OUTPUT_STATE_NAME = "state_out"

    /** Whether the filter is enabled by default. */
    const val DEFAULT_ENABLED = true
}
