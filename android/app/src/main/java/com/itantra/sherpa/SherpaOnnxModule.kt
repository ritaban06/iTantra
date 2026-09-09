package com.itantra.sherpa

import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import java.io.ByteArrayOutputStream
import java.util.concurrent.ConcurrentLinkedQueue
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.itantra.audio.AudioCaptureManager

/**
 * EXPERIMENTAL NativeSherpa RN bridge (Android Speech Integration Gate).
 *
 * Exposes the sherpa-onnx proof-of-concept engines to JS for diagnostics.
 * The production NativeSTT / NativeTTS / NativeBLE modules are untouched.
 *
 * Events emitted (experimental, SHERPA_-prefixed):
 *  - SHERPA_PARTIAL  { text }
 *  - SHERPA_RESULT   { text, language, isStreaming }
 *  - SHERPA_ERROR    { code, message }
 *
 * VAD results are returned via promise (segment arrays), not via events.
 * The existing STT_RESULT / STT_PARTIAL / TTS / muteMic contracts are NOT used
 * here, so wiring this module cannot disturb the production voice path.
 */
class SherpaOnnxModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val TAG = "NativeSherpa"
    }

    private val stt = SherpaOnnxSTTEngine()
    private val tts = SherpaOnnxTTSEngine()
    private val vad = SherpaOnnxVadEngine()

    private var audioManager: AudioCaptureManager? = null
    private var isListening = false
    private var isSpeaking = false
    private var isCapturing = false

    init {
        stt.onPartialResult = { text ->
            emit("SHERPA_PARTIAL", Arguments.createMap().apply { putString("text", text) })
        }
        stt.onFinalResult = { text ->
            emit("SHERPA_RESULT", Arguments.createMap().apply {
                putString("text", text)
                putString("language", stt.currentLanguage)
                putBoolean("isStreaming", stt.isStreaming)
            })
        }
        stt.onError = { msg -> emitError("STT", msg) }
        tts.onError = { msg -> emitError("TTS", msg) }
        vad.onError = { msg -> emitError("VAD", msg) }
    }

    override fun getName(): String = "NativeSherpa"

    // ── STT ──────────────────────────────────────────────────────────

    @ReactMethod
    fun loadSTT(language: String, promise: Promise) {
        try {
            val ok = stt.load(language, reactApplicationContext.assets)
            if (ok) {
                val m = Arguments.createMap().apply {
                    putString("language", language)
                    putBoolean("isStreaming", stt.isStreaming)
                }
                promise.resolve(m)
            } else {
                promise.reject("SHERPA_STT_LOAD_FAILED", "Failed to load sherpa-onnx STT model for $language")
            }
        } catch (t: Throwable) {
            promise.reject("SHERPA_STT_LOAD_ERROR", t.message)
        }
    }

    /** Start live microphone capture (reuses the production AudioCaptureManager). */
    @ReactMethod
    fun startListening(promise: Promise) {
        if (isListening) {
            promise.resolve(null)
            return
        }
        if (!stt.isLoaded) {
            promise.reject("SHERPA_STT_NOT_LOADED", "Load an STT model first (loadSTT)")
            return
        }
        if (!stt.isStreaming) {
            promise.reject("SHERPA_OFFLINE_ONLY", "Loaded STT model is offline-only (Hindi); use captureOfflineUtterance instead")
            return
        }
        try {
            stt.startStream()
            val mgr = AudioCaptureManager(
                onChunk = { chunk -> stt.feedPcm16(chunk) },
                onError = { msg -> emitError("AUDIO", msg) },
            )
            audioManager = mgr
            mgr.startCapture()
            isListening = true
            promise.resolve(null)
        } catch (t: Throwable) {
            promise.reject("SHERPA_AUDIO_START_ERROR", t.message)
        }
    }

    /** Stop microphone capture and emit the final streaming result. */
    @ReactMethod
    fun stopListening(promise: Promise) {
        audioManager?.let { mgr ->
            mgr.stopCapture()
        }
        audioManager = null
        isListening = false
        val final = stt.finishStream()
        val m = Arguments.createMap().apply {
            putString("text", final ?: "")
            putString("language", stt.currentLanguage)
        }
        promise.resolve(m)
    }

    /** Offline (non-streaming) recognition of a base64 16 kHz mono PCM16 buffer. */
    @ReactMethod
    fun recognizeOffline(base64Pcm: String, promise: Promise) {
        try {
            val bytes = decodeBase64(base64Pcm)
            val text = stt.recognizeOffline(bytes)
            if (text != null) {
                val m = Arguments.createMap().apply {
                    putString("text", text)
                    putString("language", stt.currentLanguage)
                }
                promise.resolve(m)
            } else {
                promise.reject("SHERPA_STT_OFFLINE_EMPTY", "Offline recognition returned no text")
            }
        } catch (t: Throwable) {
            promise.reject("SHERPA_STT_OFFLINE_ERROR", t.message)
        }
    }

    // ── TTS ──────────────────────────────────────────────────────────

    @ReactMethod
    fun loadTTS(language: String, promise: Promise) {
        try {
            val ok = tts.load(language, reactApplicationContext.assets)
            if (ok) {
                promise.resolve(Arguments.createMap().apply { putString("language", language) })
            } else {
                promise.reject("SHERPA_TTS_LOAD_FAILED", "Failed to load sherpa-onnx TTS model for $language")
            }
        } catch (t: Throwable) {
            promise.reject("SHERPA_TTS_LOAD_ERROR", t.message)
        }
    }

    /** Synthesize [text] and play through the speaker. Resolves with durationMs. */
    @ReactMethod
    fun speak(text: String, language: String, promise: Promise) {
        try {
            if (tts.currentLanguage != language || !tts.isLoaded) {
                val ok = tts.load(language, reactApplicationContext.assets)
                if (!ok) {
                    promise.reject("SHERPA_TTS_LOAD_FAILED", "Failed to load sherpa-onnx TTS for $language")
                    return
                }
            }
            isSpeaking = true
            val durationMs = tts.speak(text)
            isSpeaking = false
            if (durationMs >= 0) {
                promise.resolve(Arguments.createMap().apply {
                    putDouble("durationMs", durationMs.toDouble())
                    putString("language", language)
                })
            } else {
                promise.reject("SHERPA_TTS_SYNTH_FAILED", "TTS synthesis failed")
            }
        } catch (t: Throwable) {
            isSpeaking = false
            promise.reject("SHERPA_TTS_ERROR", t.message)
        }
    }

    @ReactMethod
    fun stopSpeaking(promise: Promise) {
        tts.stop()
        isSpeaking = false
        promise.resolve(null)
    }

    // ── VAD ──────────────────────────────────────────────────────────

    @ReactMethod
    fun loadVAD(promise: Promise) {
        try {
            val ok = vad.load(reactApplicationContext.assets)
            if (ok) {
                promise.resolve(null)
            } else {
                promise.reject("SHERPA_VAD_LOAD_FAILED", "Failed to load Silero VAD model")
            }
        } catch (t: Throwable) {
            promise.reject("SHERPA_VAD_LOAD_ERROR", t.message)
        }
    }

    /** Feed a base64 16 kHz mono PCM16 chunk; resolves with segments found. */
    @ReactMethod
    fun feedVAD(base64Pcm: String, promise: Promise) {
        try {
            val bytes = decodeBase64(base64Pcm)
            val segments = vad.feedPcm16(bytes)
            val arr = Arguments.createArray()
            for (seg in segments) {
                arr.pushMap(Arguments.createMap().apply {
                    putInt("startSample", seg.startSample)
                    putInt("numSamples", seg.numSamples)
                })
            }
            promise.resolve(arr)
        } catch (t: Throwable) {
            promise.reject("SHERPA_VAD_FEED_ERROR", t.message)
        }
    }

    // ── Offline utterance capture (Hindi NeMo-CTC) ───────────────────

    /**
     * Capture [maxDurationMs] of microphone audio, then run the loaded OFFLINE
     * recognizer over the whole utterance. Hindi is the only offline language
     * today; the result is a final transcript only (never streamed).
     * Capture is bounded (1–30 s) and reuses the production AudioCaptureManager.
     */
    @ReactMethod
    fun captureOfflineUtterance(maxDurationMs: Int, promise: Promise) {
        if (isCapturing) {
            promise.reject("SHERPA_CAPTURE_BUSY", "A microphone capture is already in progress")
            return
        }
        if (!stt.isLoaded || stt.isStreaming) {
            promise.reject("SHERPA_OFFLINE_NOT_LOADED", "Offline STT model required (loadSTT('hi'))")
            return
        }
        val durationMs = maxDurationMs.coerceIn(1000, 30000)
        isCapturing = true
        Thread {
            try {
                val buffer = ByteArrayOutputStream()
                val mgr = AudioCaptureManager(
                    onChunk = { chunk ->
                        synchronized(buffer) { buffer.write(chunk) }
                    },
                    onError = { msg -> Log.e(TAG, "[AUDIO] $msg") },
                )
                audioManager = mgr
                mgr.startCapture()
                Thread.sleep(durationMs.toLong())
                mgr.stopCapture()
                audioManager = null
                // Let any in-flight chunk land before recognizing.
                Thread.sleep(250)
                val pcm = synchronized(buffer) { buffer.toByteArray() }
                val text = stt.recognizeOffline(pcm)
                if (text != null && text.isNotBlank()) {
                    val m = Arguments.createMap().apply {
                        putString("text", text)
                        putString("language", stt.currentLanguage)
                        putInt("pcmBytes", pcm.size)
                    }
                    promise.resolve(m)
                } else {
                    promise.reject("SHERPA_STT_OFFLINE_EMPTY", "No speech recognized (silence or capture failure)")
                }
            } catch (t: Throwable) {
                Log.e(TAG, "captureOfflineUtterance failed", t)
                promise.reject("SHERPA_CAPTURE_ERROR", t.message)
            } finally {
                isCapturing = false
            }
        }.start()
    }

    // ── Silero VAD microphone test ───────────────────────────────────

    /**
     * Capture [durationMs] of microphone audio through Silero VAD and return the
     * speech segments found (start sample, sample count). Bounded capture:
     * silence -> no segments; speech -> segments; trailing silence ends them.
     */
    @ReactMethod
    fun runVadTest(durationMs: Int, promise: Promise) {
        if (isCapturing) {
            promise.reject("SHERPA_CAPTURE_BUSY", "A microphone capture is already in progress")
            return
        }
        if (!vad.isLoaded) {
            promise.reject("SHERPA_VAD_NOT_LOADED", "Load the Silero VAD model first (loadVAD)")
            return
        }
        val duration = durationMs.coerceIn(1000, 30000)
        isCapturing = true
        Thread {
            try {
                val segments = ConcurrentLinkedQueue<Pair<Int, Int>>()
                val mgr = AudioCaptureManager(
                    onChunk = { chunk ->
                        for (seg in vad.feedPcm16(chunk)) {
                            segments.add(seg.startSample to seg.numSamples)
                        }
                    },
                    onError = { msg -> Log.e(TAG, "[AUDIO] $msg") },
                )
                audioManager = mgr
                mgr.startCapture()
                Thread.sleep(duration.toLong())
                mgr.stopCapture()
                audioManager = null
                // Let any in-flight chunk land before reporting.
                Thread.sleep(250)
                val arr = Arguments.createArray()
                for ((start, count) in segments) {
                    arr.pushMap(Arguments.createMap().apply {
                        putInt("startSample", start)
                        putInt("numSamples", count)
                    })
                }
                promise.resolve(arr)
            } catch (t: Throwable) {
                Log.e(TAG, "runVadTest failed", t)
                promise.reject("SHERPA_VAD_TEST_ERROR", t.message)
            } finally {
                isCapturing = false
            }
        }.start()
    }

    // ── Lifecycle / diagnostics ──────────────────────────────────────

    @ReactMethod
    fun isLoaded(promise: Promise) {
        promise.resolve(Arguments.createMap().apply {
            putBoolean("sttStreaming", stt.isStreaming)
            putBoolean("sttOffline", stt.isLoaded && !stt.isStreaming)
            putBoolean("tts", tts.isLoaded)
            putBoolean("vad", vad.isLoaded)
        })
    }

    @ReactMethod
    fun releaseAll(promise: Promise) {
        audioManager?.stopCapture()
        audioManager = null
        isListening = false
        tts.stop()
        isSpeaking = false
        stt.release()
        tts.release()
        vad.release()
        promise.resolve(null)
    }

    // ── Helpers ──────────────────────────────────────────────────────

    private fun emit(eventName: String, params: WritableMap?) {
        if (reactApplicationContext.hasActiveCatalystInstance()) {
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(eventName, params)
        }
    }

    private fun emitError(code: String, message: String) {
        Log.e(TAG, "[$code] $message")
        emit("SHERPA_ERROR", Arguments.createMap().apply {
            putString("code", code)
            putString("message", message)
        })
    }

    private fun decodeBase64(input: String): ByteArray {
        return Base64.decode(input, Base64.DEFAULT)
    }
}