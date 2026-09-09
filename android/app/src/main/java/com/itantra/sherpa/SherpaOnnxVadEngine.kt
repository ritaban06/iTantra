package com.itantra.sherpa

import android.content.res.AssetManager
import android.util.Log
import com.k2fsa.sherpa.onnx.SileroVadModelConfig
import com.k2fsa.sherpa.onnx.SpeechSegment
import com.k2fsa.sherpa.onnx.Vad
import com.k2fsa.sherpa.onnx.VadModelConfig
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * EXPERIMENTAL Silero VAD via sherpa-onnx (Android Speech Integration Gate).
 *
 * Isolated from the production energy-based [com.itantra.audio.VoiceActivityDetector].
 * 16 kHz mono PCM16 in, speech segment start/duration out.
 */
class SherpaOnnxVadEngine {

    companion object {
        private const val TAG = "SherpaOnnxVad"
        private const val SAMPLE_RATE = 16000
    }

    /** Speech segment described by sample indices. */
    data class Segment(val startSample: Int, val numSamples: Int)

    var onError: ((String) -> Unit)? = null

    private var vad: Vad? = null
    private var acceptedSamples = 0

    /** True when the Silero model is loaded. */
    val isLoaded: Boolean
        get() = vad != null

    /**
     * Load the bundled Silero VAD model from assets.
     * Returns true on success; emits [onError] and returns false otherwise.
     */
    fun load(assetManager: AssetManager): Boolean {
        release()
        return try {
            val config = VadModelConfig(
                sileroVadModelConfig = SileroVadModelConfig(
                    model = "sherpa/vad/silero_vad.onnx",
                    threshold = 0.5f,
                    minSilenceDuration = 0.25f,
                    minSpeechDuration = 0.25f,
                    windowSize = 512,
                ),
                sampleRate = SAMPLE_RATE,
                numThreads = 1,
            )
            vad = Vad(assetManager, config)
            acceptedSamples = 0
            true
        } catch (t: Throwable) {
            Log.e(TAG, "load failed", t)
            onError?.invoke("sherpa-onnx VAD load failed: ${t.message}")
            false
        }
    }

    /**
     * Feed a 16 kHz mono PCM16 chunk and drain any completed speech segments.
     * Returns segments discovered in this chunk (start sample index, sample count).
     */
    fun feedPcm16(chunk: ByteArray): List<Segment> {
        val v = vad ?: return emptyList()
        val samples = pcm16ToFloats(chunk)
        v.acceptWaveform(samples)
        acceptedSamples += samples.size

        val out = mutableListOf<Segment>()
        while (!v.empty()) {
            val seg: SpeechSegment = v.front()
            v.pop()
            // Segments may be partially complete; only report ones with plausible length.
            if (seg.samples.isNotEmpty()) {
                out.add(Segment(startSample = seg.start, numSamples = seg.samples.size))
            }
        }
        return out
    }

    /** Whether speech is currently being detected inside the VAD window. */
    fun isSpeechDetected(): Boolean = vad?.isSpeechDetected() ?: false

    /** Reset the VAD state (start of a new utterance session). */
    fun reset() {
        vad?.reset()
        acceptedSamples = 0
    }

    fun release() {
        vad?.release()
        vad = null
        acceptedSamples = 0
    }

    private fun pcm16ToFloats(pcm: ByteArray): FloatArray {
        val shorts = ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
        val out = FloatArray(shorts.remaining())
        for (i in out.indices) {
            out[i] = shorts.get() / 32768.0f
        }
        return out
    }
}