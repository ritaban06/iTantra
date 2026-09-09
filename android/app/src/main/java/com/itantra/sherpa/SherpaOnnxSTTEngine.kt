package com.itantra.sherpa

import android.content.res.AssetManager
import android.util.Log
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineNemoEncDecCtcModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineStream
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineRecognizer
import com.k2fsa.sherpa.onnx.OnlineRecognizerConfig
import com.k2fsa.sherpa.onnx.OnlineStream
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * EXPERIMENTAL sherpa-onnx STT engine (Android Speech Integration Gate).
 *
 * Isolated from the production STT stack (Vosk / IndicConformer-STTModule).
 * The production engines in com.itantra.stt are untouched.
 *
 * Supported right now:
 *  - "en": streaming zipformer transducer (partials + endpointing), bundled in
 *          assets/sherpa/en-stt
 *  - "hi": OFFLINE (non-streaming) NeMo-CTC IndicConformer int8, bundled in
 *          assets/sherpa/hi-stt. Honest limitation: the tested IndicConformer
 *          export is NOT a sherpa-onnx online transducer, so Hindi is
 *          utterance-only, never fake-streamed.
 */
class SherpaOnnxSTTEngine {

    companion object {
        private const val TAG = "SherpaOnnxSTT"
        private const val SAMPLE_RATE = 16000
        private const val FEATURE_DIM = 80
    }

    var onPartialResult: ((String) -> Unit)? = null
    var onFinalResult: ((String) -> Unit)? = null
    var onError: ((String) -> Unit)? = null

    var currentLanguage: String = "en"
        private set

    /** True when any STT model (streaming or offline) is loaded. */
    val isLoaded: Boolean
        get() = online != null || offline != null

    /** True = streaming online recognizer (en); false = offline utterance recognizer (hi). */
    val isStreaming: Boolean
        get() = online != null

    private var online: OnlineRecognizer? = null
    private var offline: OfflineRecognizer? = null
    private var stream: OnlineStream? = null

    // ── Model loading ────────────────────────────────────────────────

    /**
     * Load the bundled model for [language] from Android assets.
     * Returns true on success; on failure emits [onError] and returns false.
     * A previous model (any language) is unloaded first.
     */
    fun load(language: String, assetManager: AssetManager): Boolean {
        release()
        currentLanguage = language
        return try {
            when (language) {
                "en" -> {
                    val config = OnlineRecognizerConfig(
                        featConfig = FeatureConfig(sampleRate = SAMPLE_RATE, featureDim = FEATURE_DIM),
                        modelConfig = OnlineModelConfig(
                            transducer = OnlineTransducerModelConfig(
                                encoder = "sherpa/en-stt/encoder.int8.onnx",
                                decoder = "sherpa/en-stt/decoder.onnx",
                                joiner = "sherpa/en-stt/joiner.int8.onnx",
                            ),
                            tokens = "sherpa/en-stt/tokens.txt",
                            numThreads = 2,
                            // modelType stays "" (auto-detected from transducer) —
                            // matches the proven POC configuration.
                        ),
                        enableEndpoint = true,
                        decodingMethod = "greedy_search",
                    )
                    online = OnlineRecognizer(assetManager, config)
                    true
                }
                "hi" -> {
                    val config = OfflineRecognizerConfig(
                        featConfig = FeatureConfig(sampleRate = SAMPLE_RATE, featureDim = FEATURE_DIM),
                        modelConfig = OfflineModelConfig(
                            nemo = OfflineNemoEncDecCtcModelConfig(model = "sherpa/hi-stt/model.int8.onnx"),
                            tokens = "sherpa/hi-stt/tokens.txt",
                            numThreads = 2,
                            modelType = "nemo_ctc",
                        ),
                        decodingMethod = "greedy_search",
                    )
                    offline = OfflineRecognizer(assetManager, config)
                    true
                }
                else -> {
                    onError?.invoke("Unsupported sherpa-onnx STT language: $language")
                    false
                }
            }
        } catch (t: Throwable) {
            Log.e(TAG, "load($language) failed", t)
            onError?.invoke("sherpa-onnx STT load failed: ${t.message}")
            false
        }
    }

    // ── Streaming path (English) ─────────────────────────────────────

    /** Start a fresh streaming session. No-op when no online model is loaded. */
    fun startStream() {
        val rec = online ?: return
        stream?.release()
        stream = rec.createStream()
    }

    /**
     * Feed a 16 kHz mono PCM16 chunk into the streaming recognizer,
     * emitting partial results and endpoint finals as they become ready.
     */
    fun feedPcm16(chunk: ByteArray) {
        val rec = online ?: return
        val s = stream ?: run {
            val fresh = rec.createStream()
            stream = fresh
            fresh
        }
        val samples = pcm16ToFloats(chunk)
        s.acceptWaveform(samples, SAMPLE_RATE)
        while (rec.isReady(s)) {
            rec.decode(s)
        }
        val text = rec.getResult(s).text
        if (text.isNotBlank()) {
            onPartialResult?.invoke(text)
        }
        if (rec.isEndpoint(s)) {
            val finalText = rec.getResult(s).text
            if (finalText.isNotBlank()) {
                onFinalResult?.invoke(finalText)
            }
            rec.reset(s)
        }
    }

    /** Signal end-of-input and return the final streaming transcript (or null). */
    fun finishStream(): String? {
        val rec = online ?: return null
        val s = stream ?: return null
        s.inputFinished()
        while (rec.isReady(s)) {
            rec.decode(s)
        }
        val text = rec.getResult(s).text
        stream = null
        if (text.isNotBlank()) {
            onFinalResult?.invoke(text)
        }
        return text
    }

    // ── Offline path (Hindi) ─────────────────────────────────────────

    /**
     * Recognize a complete 16 kHz mono PCM16 utterance offline.
     * Returns the transcript, or null on failure / no model.
     */
    fun recognizeOffline(pcm16: ByteArray): String? {
        val rec = offline ?: return null
        return try {
            val s: OfflineStream = rec.createStream()
            try {
                s.acceptWaveform(pcm16ToFloats(pcm16), SAMPLE_RATE)
                rec.decode(s)
                rec.getResult(s).text
            } finally {
                s.release()
            }
        } catch (t: Throwable) {
            Log.e(TAG, "recognizeOffline failed", t)
            onError?.invoke("sherpa-onnx offline decode failed: ${t.message}")
            null
        }
    }

    // ── Lifecycle ────────────────────────────────────────────────────

    fun release() {
        stream?.release()
        stream = null
        online?.release()
        online = null
        offline?.release()
        offline = null
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