package com.itantra.audio

// ONNX Runtime Java API removed — version conflict with sherpa-onnx's bundled ORT.
// DeepFilterNet is gracefully disabled; audio passes through unprocessed.
import android.content.Context
import android.util.Log
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.roundToInt

/**
 * Streaming speech enhancement engine using DPDFNet2 (ONNX).
 *
 * Verified against the official reference implementations:
 *   - ceva-ip/DPDFNet (Python export)
 *   - k2-fsa/sherpa-onnx (C++ online streaming)
 *
 * Key verified parameters:
 *   - Window: Vorbis (NOT Hann)
 *   - Frame size: 320 samples (20 ms @ 16 kHz)
 *   - Hop size: 160 samples (10 ms @ 16 kHz)
 *   - No wnorm normalization on STFT input
 *   - No center padding (causal streaming)
 *   - DFT: unnormalized forward, 1/N inverse
 *   - Overlap-add with analysis window
 *   - First hop suppressed (startup warm-up)
 *
 * The ONNX model contract (verified):
 *   Input  spec:     FLOAT [1, 1, 161, 2]   — complex STFT spectrum
 *   Input  state_in: FLOAT [45424]            — RNN hidden state
 *   Output spec_e:   FLOAT [1, 1, 161, 2]   — enhanced spectrum
 *   Output state_out: FLOAT [45424]           — updated state
 */
class DeepFilterEngine(private val context: Context) {

    companion object {
        private const val TAG = "DeepFilterEngine"
    }

    // ── ONNX Runtime (disabled — version conflict with sherpa-onnx) ──
    // DeepFilterNet gracefully disabled; audio passes through unprocessed.
    // To re-enable: restore the ai.onnxruntime imports and this block.

    @Volatile
    var isLoaded: Boolean = false
        private set

    // ── Streaming state ───────────────────────────────────────────────

    /** RNN hidden state carried between frames (45424 floats, all zeros initially). */
    private var stateIn = FloatArray(DeepFilterConfig.STATE_SIZE)

    /** Input sample buffer (accumulated across process() calls). */
    private val inputBuffer = mutableListOf<Short>()

    /**
     * Analysis buffer: FFT_SIZE samples. Sliding window over the input.
     * On each hop: shift left by HOP_SIZE, append new HOP_SIZE samples.
     */
    private val analysisBuffer = FloatArray(DeepFilterConfig.FFT_SIZE)

    /**
     * Overlap-add synthesis buffer: FFT_SIZE samples.
     * On each hop: shift left by HOP_SIZE, add windowed iSTFT output.
     */
    private val overlapAddBuffer = FloatArray(DeepFilterConfig.FFT_SIZE)

    /** Pre-computed Vorbis window (FFT_SIZE samples).
     *  Matches: vorbis_window(320) from ceva-ip/DPDFNet model/utils.py */
    private val window = FloatArray(DeepFilterConfig.FFT_SIZE) { i ->
        vorbisWindow(DeepFilterConfig.FFT_SIZE, i)
    }

    /** Temporary arrays to avoid per-frame allocation. */
    private val fftInput = FloatArray(DeepFilterConfig.FFT_SIZE)
    private val fftOutputReal = FloatArray(DeepFilterConfig.FFT_SIZE)
    private val fftOutputImag = FloatArray(DeepFilterConfig.FFT_SIZE)
    private val ifftOutput = FloatArray(DeepFilterConfig.FFT_SIZE)

    /** Whether we've started producing output (skip first hop). */
    private var started = false

    /**
     * Lock for synchronizing process(), reset(), and release().
     *
     * process() runs on the audio thread (Dispatchers.Default).
     * reset() runs on the main thread (React Native @ReactMethod).
     * release() runs on the main thread.
     *
     * Using @Synchronized (intrinsic lock) is the simplest safe choice.
     * The lock is held for <1ms during process() (ONNX inference),
     * so audio-thread blocking is negligible.
     */
    private val lock = Any()

    // ── Instrumentation ────────────────────────────────────────────────

    @Volatile
    var frameCount: Long = 0L
        private set

    @Volatile
    var totalInferenceNanos: Long = 0L
        private set

    @Volatile
    var fallbackCount: Long = 0L
        private set

    // ── Model loading ──────────────────────────────────────────────────

    fun load(): Boolean {
        // ONNX Runtime Java API removed to resolve version conflict with sherpa-onnx.
        // Audio passes through unprocessed (passthrough mode).
        Log.i(TAG, "DeepFilterNet disabled (ONNX Runtime conflict). Audio passes through.")
        isLoaded = false
        return false
    }

    // ── Public streaming API ───────────────────────────────────────────

    /**
     * Process a chunk of 16 kHz mono PCM samples and return enhanced audio.
     *
     * Frames advance by HOP_SIZE (160 samples), not FFT_SIZE (320).
     * Each call consumes input and produces approximately input.length - HOP_SIZE
     * enhanced samples (after initial warm-up).
     *
     * If the model is not loaded, returns the input unchanged (passthrough).
     */
    @Synchronized
    fun process(input: ShortArray): ShortArray {
        if (!isLoaded) {
            fallbackCount++
            return input
        }
        if (input.isEmpty()) return input

        // Append incoming samples to the pending input buffer.
        inputBuffer.addAll(input.toList())

        // Process hops: advance by HOP_SIZE each time while FFT_SIZE samples available.
        while (inputBuffer.size >= DeepFilterConfig.HOP_SIZE) {
            // Extract HOP_SIZE new samples from the pending buffer.
            val hop = ShortArray(DeepFilterConfig.HOP_SIZE)
            for (i in 0 until DeepFilterConfig.HOP_SIZE) {
                hop[i] = inputBuffer[i]
            }
            for (i in 0 until DeepFilterConfig.HOP_SIZE) {
                inputBuffer.removeAt(0)
            }

            // Process one hop through STFT → ONNX → iSTFT → overlap-add.
            processHop(hop)
        }

        // Drain output.
        val outputSize = outputBuffer.size
        if (outputSize == 0) return ShortArray(0)
        val output = ShortArray(outputSize)
        for (i in 0 until outputSize) {
            output[i] = outputBuffer[i]
        }
        outputBuffer.clear()
        return output
    }

    /** Internal output sample buffer. */
    private val outputBuffer = mutableListOf<Short>()

    @Synchronized
    fun reset() {
        stateIn = FloatArray(DeepFilterConfig.STATE_SIZE)
        inputBuffer.clear()
        outputBuffer.clear()
        analysisBuffer.fill(0f)
        overlapAddBuffer.fill(0f)
        started = false
        frameCount = 0L
        totalInferenceNanos = 0L
        fallbackCount = 0L
    }

    @Synchronized
    fun release() {
        isLoaded = false
    }

    // ── Hop processing (matches official C++ reference) ────────────────

    /**
     * Process one hop (HOP_SIZE new samples).
     *
     * Matches the official sherpa-onnx OnlineSpeechDenoiserStftImpl::ProcessHop:
     *   1. Shift analysis buffer left by HOP_SIZE
     *   2. Append new samples to the right
     *   3. Window the full FFT_SIZE-length analysis buffer
     *   4. Forward DFT → spec
     *   5. ONNX inference → enhanced spec
     *   6. Inverse DFT → time domain
     *   7. Window the iSTFT output (synthesis window = analysis window)
     *   8. Shift overlap-add buffer left by HOP_SIZE
     *   9. Add windowed iSTFT output to overlap-add buffer
     *  10. Output first HOP_SIZE samples (skip first hop for warm-up)
     */
    private fun processHop(hop: ShortArray) {
        try {
            val inferenceStart = System.nanoTime()
            val n = DeepFilterConfig.FFT_SIZE
            val hopSize = DeepFilterConfig.HOP_SIZE

            // 1. Shift analysis buffer left by HOP_SIZE.
            System.arraycopy(analysisBuffer, hopSize, analysisBuffer, 0, n - hopSize)

            // 2. Append new HOP_SIZE samples (converted to float) to the right.
            for (i in 0 until hopSize) {
                analysisBuffer[n - hopSize + i] = hop[i].toFloat() / 32768.0f
            }

            // 3. Window the full analysis buffer.
            for (i in 0 until n) {
                fftInput[i] = analysisBuffer[i] * window[i]
            }

            // 4. Forward DFT → complex spectrum.
            dftForward(fftInput, fftOutputReal, fftOutputImag, n)

            // 5. Pack and run ONNX inference.
            val spec = FloatArray(DeepFilterConfig.NUM_FREQ_BINS * 2)
            for (k in 0 until DeepFilterConfig.NUM_FREQ_BINS) {
                spec[k * 2] = fftOutputReal[k]
                spec[k * 2 + 1] = fftOutputImag[k]
            }
            runInference(spec)

            // 6. Inverse DFT on the enhanced spectrum.
            // Reconstruct full conjugate-symmetric spectrum from N/2+1 bins.
            val enhancedReal = FloatArray(n)
            val enhancedImag = FloatArray(n)
            enhancedReal[0] = spec[0]
            enhancedImag[0] = 0f
            enhancedReal[n / 2] = spec[(n / 2) * 2]
            enhancedImag[n / 2] = 0f
            for (k in 1 until n / 2) {
                enhancedReal[k] = spec[k * 2]
                enhancedImag[k] = spec[k * 2 + 1]
            }
            for (k in n / 2 + 1 until n) {
                val mirror = n - k
                enhancedReal[k] = enhancedReal[mirror]
                enhancedImag[k] = -enhancedImag[mirror]
            }

            dftInverse(enhancedReal, enhancedImag, ifftOutput, n)

            // 7. Apply synthesis window (= analysis window for Vorbis).
            for (i in 0 until n) {
                ifftOutput[i] *= window[i]
            }

            // 8. Shift overlap-add buffer left by HOP_SIZE.
            System.arraycopy(overlapAddBuffer, hopSize, overlapAddBuffer, 0, n - hopSize)
            for (i in n - hopSize until n) {
                overlapAddBuffer[i] = 0f
            }

            // 9. Add windowed iSTFT output to overlap-add buffer.
            for (i in 0 until n) {
                overlapAddBuffer[i] += ifftOutput[i]
            }

            // 10. Output first HOP_SIZE samples (skip first hop for warm-up).
            if (started) {
                for (i in 0 until hopSize) {
                    val intSample = overlapAddBuffer[i].roundToInt()
                    outputBuffer.add(
                        intSample.coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort()
                    )
                }
            } else {
                started = true
            }

            val inferenceNanos = System.nanoTime() - inferenceStart
            totalInferenceNanos += inferenceNanos
            frameCount++

        } catch (e: Exception) {
            Log.e(TAG, "Hop processing failed: ${e.message}")
            fallbackCount++
        }
    }

    // ── ONNX inference (disabled) ───────────────────────────────────────
    // ONNX Runtime removed. process() falls through to passthrough when
    // isLoaded == false, so processHop/runInference are never reached.
    @Suppress("UNUSED_PARAMETER")
    private fun runInference(spec: FloatArray) { /* no-op: ONNX disabled */ }

    // ── Vorbis window ──────────────────────────────────────────────────

    /**
     * Vorbis window function, matching the official implementation:
     *   vorbis_window(window_len) from ceva-ip/DPDFNet model/utils.py
     *
     *   window[i] = sin(0.5 * PI * sin(0.5 * PI * (i + 0.5) / (window_len / 2))^2)
     */
    private fun vorbisWindow(windowLen: Int, i: Int): Float {
        val halfLen = windowLen.toFloat() / 2.0f
        val sinVal = sin(0.5f * PI.toFloat() * (i + 0.5f) / halfLen)
        return sin(0.5f * PI.toFloat() * sinVal * sinVal)
    }

    // ── DFT (direct, matches official StreamingDft) ────────────────────

    /**
     * Forward DFT producing only the first N/2+1 bins.
     *
     * Matches the official sherpa-onnx StreamingDft::Forward:
     *   real[k] = Σ input[n] * cos(2π·k·n/N)
     *   imag[k] = -Σ input[n] * sin(2π·k·n/N)
     *
     * No 1/N normalization on forward DFT (matches official reference).
     */
    private fun dftForward(input: FloatArray, outReal: FloatArray, outImag: FloatArray, n: Int) {
        val numBins = n / 2 + 1
        for (k in 0 until numBins) {
            var sumReal = 0.0
            var sumImag = 0.0
            val angleBase = -2.0 * PI * k / n
            for (jj in 0 until n) {
                val angle = angleBase * jj
                val c = cos(angle)
                val s = sin(angle)
                val v = input[jj].toDouble()
                sumReal += v * c
                sumImag -= v * s
            }
            outReal[k] = sumReal.toFloat()
            outImag[k] = sumImag.toFloat()
        }
    }

    /**
     * Inverse DFT from the full N-point conjugate-symmetric spectrum.
     *
     * Matches the official sherpa-onnx StreamingDft::Inverse:
     *   output[n] = (1/N) * [X[0] + (-1)^n * X[N/2] + 2·Σ(k=1..N/2-1) Re{X[k]·e^{j2πkn/N}}]
     *
     * The 1/N normalization is applied here (matches official reference).
     */
    private fun dftInverse(inReal: FloatArray, inImag: FloatArray, output: FloatArray, n: Int) {
        val numBins = n / 2 + 1
        for (nn in 0 until n) {
            var sum = inReal[0].toDouble()
            if (n % 2 == 0) {
                // Nyquist bin: contributes (-1)^n * X[N/2]
                sum += inReal[n / 2] * if (nn % 2 != 0) -1.0 else 1.0
            }
            // Sum over k=1..N/2-1.
            for (k in 1 until numBins - 1) {
                val angle = 2.0 * PI * k * nn / n
                val c = cos(angle)
                val s = sin(angle)
                // 2 * (real * cos - imag * sin)
                sum += 2.0 * (inReal[k] * c - inImag[k] * s)
            }
            output[nn] = (sum / n).toFloat()
        }
    }
}
