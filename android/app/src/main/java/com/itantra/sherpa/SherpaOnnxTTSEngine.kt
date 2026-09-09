package com.itantra.sherpa

import android.content.res.AssetManager
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.util.Log
import com.k2fsa.sherpa.onnx.GeneratedAudio
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig

/**
 * EXPERIMENTAL sherpa-onnx VITS TTS engine (Android Speech Integration Gate).
 *
 * Isolated from the production TTS stack (Android system TextToSpeech via
 * com.itantra.tts.AndroidTTSFallback) — the production engine is untouched.
 *
 * Supports "en" and "hi" using bundled MMS VITS models in assets/sherpa/{en,hi}-tts.
 * Synthesis streams float PCM directly to an AudioTrack, mirroring the official
 * SherpaOnnxTts sample app.
 */
class SherpaOnnxTTSEngine {

    companion object {
        private const val TAG = "SherpaOnnxTTS"
    }

    var onError: ((String) -> Unit)? = null

    private var tts: OfflineTts? = null
    private var track: AudioTrack? = null
    private var playbackStopped = false

    var currentLanguage: String = "en"
        private set

    /** True when a model is loaded. */
    val isLoaded: Boolean
        get() = tts != null

    /**
     * Load the bundled MMS VITS model for [language] from assets.
     * Returns true on success; emits [onError] and returns false otherwise.
     */
    fun load(language: String, assetManager: AssetManager): Boolean {
        release()
        currentLanguage = language
        return try {
            val (modelPath, tokensPath) = if (language == "hi") {
                "sherpa/hi-tts/model.onnx" to "sherpa/hi-tts/tokens.txt"
            } else {
                "sherpa/en-tts/model.onnx" to "sherpa/en-tts/tokens.txt"
            }
            val config = OfflineTtsConfig(
                model = OfflineTtsModelConfig(
                    vits = OfflineTtsVitsModelConfig(
                        model = modelPath,
                        tokens = tokensPath,
                    ),
                    numThreads = 2,
                ),
                maxNumSentences = 1,
            )
            tts = OfflineTts(assetManager, config)
            initAudioTrack()
            true
        } catch (t: Throwable) {
            Log.e(TAG, "load($language) failed", t)
            onError?.invoke("sherpa-onnx TTS load failed: ${t.message}")
            false
        }
    }

    /**
     * Synthesize [text] and play it through the speaker.
     * Returns the approximate playback duration in ms, or -1 on failure.
     */
    fun speak(text: String): Long {
        val engine = tts ?: run {
            onError?.invoke("sherpa-onnx TTS not loaded")
            return -1L
        }
        if (text.isBlank()) {
            onError?.invoke("Empty text for sherpa-onnx TTS")
            return -1L
        }
        return try {
            playbackStopped = false
            val audio: GeneratedAudio = engine.generate(
                text = text,
                sid = 0,
                speed = 1.0f,
            )
            val samples = audio.samples
            if (samples.isEmpty()) {
                Log.e(TAG, "TTS produced no audio for: $text")
                onError?.invoke("sherpa-onnx TTS produced no audio")
                return -1L
            }
            playPcm(samples, audio.sampleRate)
            val durationMs = samples.size * 1000L / audio.sampleRate
            Log.i(TAG, "Spoke ${samples.size} samples @ ${audio.sampleRate} Hz (~${durationMs} ms)")
            durationMs
        } catch (t: Throwable) {
            Log.e(TAG, "synthesize failed", t)
            onError?.invoke("sherpa-onnx TTS synthesis failed: ${t.message}")
            -1L
        }
    }

    /** Stop current playback and clear the track buffer. */
    fun stop() {
        playbackStopped = true
        try {
            track?.pause()
            track?.flush()
        } catch (t: Throwable) {
            Log.w(TAG, "stop(): ${t.message}")
        }
    }

    fun release() {
        playbackStopped = true
        try {
            track?.stop()
            track?.release()
        } catch (t: Throwable) {
            Log.w(TAG, "release(): ${t.message}")
        }
        track = null
        tts?.free()
        tts = null
    }

    private fun initAudioTrack() {
        val engine = tts ?: return
        val sampleRate = engine.sampleRate()
        val bufLength = AudioTrack.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_FLOAT,
        )
        val attr = AudioAttributes.Builder()
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .build()
        val format = AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .setSampleRate(sampleRate)
            .build()
        track = AudioTrack(
            attr, format, bufLength, AudioTrack.MODE_STREAM,
            AudioManager.AUDIO_SESSION_ID_GENERATE,
        )
    }

    private fun playPcm(samples: FloatArray, sampleRate: Int) {
        var t = track
        if (t == null || t.sampleRate != sampleRate) {
            releaseTrack()
            initAudioTrackFor(sampleRate)
            t = track
        }
        t?.play()
        // Stream in chunks so large utterances don't block for too long.
        val chunkSize = 4096
        var offset = 0
        while (offset < samples.size && !playbackStopped) {
            val end = minOf(offset + chunkSize, samples.size)
            t?.write(samples, offset, end - offset, AudioTrack.WRITE_BLOCKING)
            offset = end
        }
        if (!playbackStopped) {
            t?.stop()
        }
    }

    private fun initAudioTrackFor(sampleRate: Int) {
        val bufLength = AudioTrack.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_FLOAT,
        )
        val attr = AudioAttributes.Builder()
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .build()
        val format = AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .setSampleRate(sampleRate)
            .build()
        track = AudioTrack(
            attr, format, bufLength, AudioTrack.MODE_STREAM,
            AudioManager.AUDIO_SESSION_ID_GENERATE,
        )
    }

    private fun releaseTrack() {
        try {
            track?.stop()
            track?.release()
        } catch (t: Throwable) {
            Log.w(TAG, "releaseTrack(): ${t.message}")
        }
        track = null
    }
}