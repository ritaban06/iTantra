package com.itantra.stt

import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.itantra.audio.AudioCaptureManager
import com.itantra.audio.DeepFilterConfig
import com.itantra.audio.DeepFilterEngine
import com.itantra.audio.VoiceActivityDetector
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.nio.ByteBuffer
import java.nio.ByteOrder

class STTModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    companion object {
        var instance: STTModule? = null
    }

    init {
        instance = this
    }

    private var sttEngine: STTEngine? = null
    private var audioManager: AudioCaptureManager? = null
    private val vad = VoiceActivityDetector()
    private var currentLanguage = "en"
    private var deepFilter: DeepFilterEngine? = null
    
    var onFinalResultIntercept: ((String, Double, String) -> Unit)? = null
    
    override fun getName() = "NativeSTT"

    fun getAudioManager(): AudioCaptureManager? = audioManager

    private fun emitEvent(eventName: String, params: WritableMap?) {
        if (reactApplicationContext.hasActiveCatalystInstance()) {
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(eventName, params)
        }
    }

    @ReactMethod
    fun loadModel(language: String, promise: Promise) {
        val config = ModelManager.getConfig(language)
        if (config == null) {
            promise.reject("MODEL_NOT_FOUND", "Language $language not configured.")
            return
        }

        sttEngine?.release()
        
        sttEngine = when (config.engine) {
            EngineType.VOSK -> {
                val voskPath = ModelManager.getVoskModelPath(reactApplicationContext, config.modelPath)
                if (voskPath == null) {
                    promise.reject("MODEL_LOAD_FAILED", "Vosk model not found locally.")
                    return
                }
                VoskSTTEngine(voskPath)
            }
            EngineType.INDIC_CONFORMER -> {
                IndicConformerSTTEngine(reactApplicationContext, language)
            }
        }

        sttEngine?.apply {
            onPartialResult = { partial ->
                val map = Arguments.createMap().apply {
                    putString("partial", partial)
                    putString("language", language)
                }
                emitEvent("STT_PARTIAL", map)
            }
            onFinalResult = { result ->
                val map = Arguments.createMap().apply {
                    putString("transcript", result.transcript)
                    putDouble("confidence", result.confidence.toDouble())
                    putString("language", language)
                    putDouble("durationMs", result.durationMs.toDouble())
                }
                emitEvent("STT_RESULT", map)
                onFinalResultIntercept?.invoke(result.transcript, result.confidence.toDouble(), language)
            }
            onError = { error ->
                val map = Arguments.createMap().apply {
                    putString("message", error)
                }
                emitEvent("STT_ERROR", map)
            }
        }

        val loaded = when (config.engine) {
            EngineType.VOSK -> sttEngine?.loadModel(config.modelPath)
            EngineType.INDIC_CONFORMER -> {
                val (absModel, absVocab) = ModelManager.getIndicConformerAbsolutePaths(reactApplicationContext, language)
                if (absModel != null) {
                    sttEngine?.loadModel(absModel, absVocab)
                } else {
                    sttEngine?.loadModel(config.modelPath, config.vocabPath)
                }
            }
        }

        if (loaded == true) {
            currentLanguage = language
            promise.resolve(true)
        } else {
            promise.reject("MODEL_LOAD_FAILED", "Failed to initialize STT model.")
        }
    }

    @ReactMethod
    fun unloadModel(promise: Promise) {
        deepFilter?.release()
        deepFilter = null
        sttEngine?.release()
        sttEngine = null
        promise.resolve(true)
    }

    @ReactMethod
    fun isModelLoaded(language: String, promise: Promise) {
        promise.resolve(sttEngine != null && currentLanguage == language)
    }

    @ReactMethod
    fun isModelDownloaded(language: String, promise: Promise) {
        val available = ModelManager.isModelAvailable(reactApplicationContext, language)
        promise.resolve(available)
    }

    @ReactMethod
    fun deleteModel(language: String, promise: Promise) {
        try {
            if (language == "en") {
                promise.resolve(false)
                return
            }
            val config = ModelManager.getConfig(language)
            if (config != null) {
                val externalFilesDir = reactApplicationContext.getExternalFilesDir(null)
                val modelFile = java.io.File(externalFilesDir, config.modelPath)
                if (modelFile.exists()) modelFile.delete()
                
                if (config.vocabPath != null) {
                    val vocabFile = java.io.File(externalFilesDir, config.vocabPath)
                    if (vocabFile.exists()) vocabFile.delete()
                }
                promise.resolve(true)
            } else {
                promise.resolve(false)
            }
        } catch (e: Exception) {
            promise.reject("DELETE_FAILED", e.message)
        }
    }

    @ReactMethod
    fun cancelDownload() {
        ModelManager.isDownloadCancelled = true
    }

    private val scope = CoroutineScope(Dispatchers.Main)

    @ReactMethod
    fun downloadModel(language: String, promise: Promise) {
        val config = ModelManager.getConfig(language)
        if (config == null) {
            promise.reject("MODEL_NOT_FOUND", "Language $language not configured.")
            return
        }

        ModelManager.isDownloadCancelled = false

        scope.launch {
            try {
                ModelManager.downloadModel(reactApplicationContext, language) { progress ->
                    val map = Arguments.createMap().apply {
                        putString("language", language)
                        putInt("progress", progress)
                    }
                    emitEvent("STT_DOWNLOAD_PROGRESS", map)
                }
                promise.resolve(true)
            } catch (e: Exception) {
                promise.reject("DOWNLOAD_FAILED", e.message)
            }
        }
    }

    @ReactMethod
    fun startListening(language: String, promise: Promise) {
        if (sttEngine == null) {
            promise.reject("STT_FAILED", "Model not loaded. Call loadModel first.")
            return
        }

        vad.reset()
        sttEngine?.startRecognition()

        // Load DeepFilterNet if not already loaded.
        if (deepFilter == null && DeepFilterConfig.DEFAULT_ENABLED) {
            deepFilter = DeepFilterEngine(reactApplicationContext)
            val loaded = deepFilter?.load() == true
            if (!loaded) {
                android.util.Log.w("STTModule", "DeepFilterNet failed to load — using raw audio")
                deepFilter = null
            }
        }
        deepFilter?.reset()

        if (audioManager == null) {
            audioManager = AudioCaptureManager(
                onChunk = { chunk ->
                    val shortArray = ShortArray(chunk.size / 2)
                    ByteBuffer.wrap(chunk).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(shortArray)

                    // ── DeepFilterNet: enhance audio before VAD and STT ──
                    val processedArray = if (deepFilter != null) {
                        deepFilter!!.process(shortArray)
                    } else {
                        shortArray
                    }

                    // Skip VAD/STT if DeepFilter returned empty (warm-up hop).
                    if (processedArray.isEmpty()) return@AudioCaptureManager

                    // Feed enhanced audio to VAD.
                    val stateChanged = vad.processChunk(processedArray)
                    if (stateChanged) {
                        when (vad.currentState) {
                            VoiceActivityDetector.State.SPEECH -> emitEvent("SPEECH_START", Arguments.createMap())
                            VoiceActivityDetector.State.SILENCE -> {
                                emitEvent("SPEECH_END", Arguments.createMap())
                                sttEngine?.getFinalResult()
                            }
                            else -> {}
                        }
                    }

                    // Feed enhanced audio to STT engine.
                    // Convert enhanced ShortArray back to ByteArray (little-endian PCM).
                    val enhancedChunk = ByteBuffer.allocate(processedArray.size * 2)
                        .order(ByteOrder.LITTLE_ENDIAN)
                    for (sample in processedArray) {
                        enhancedChunk.putShort(sample)
                    }
                    sttEngine?.feedChunk(enhancedChunk.array())
                },
                onError = { error ->
                    val map = Arguments.createMap().apply {
                        putString("message", error)
                    }
                    emitEvent("STT_ERROR", map)
                }
            )
        }
        
        audioManager?.startCapture()
        promise.resolve(true)
    }

    @ReactMethod
    fun stopListening(promise: Promise) {
        audioManager?.stopCapture()
        sttEngine?.getFinalResult()
        // Log DeepFilter stats for this utterance.
        deepFilter?.let {
            if (it.frameCount > 0) {
                val avgMs = it.totalInferenceNanos / it.frameCount / 1_000_000.0
                android.util.Log.i("STTModule", "DeepFilter: ${it.frameCount} frames, avg ${String.format("%.2f", avgMs)}ms/frame, ${it.fallbackCount} fallbacks")
            }
        }
        promise.resolve(true)
    }

    /**
     * Mute the microphone input. AudioRecord continues reading but chunks are discarded.
     * Used for echo prevention when TTS is playing received BLE text.
     */
    @ReactMethod
    fun muteMic() {
        audioManager?.mute()
    }

    /**
     * Unmute the microphone input after TTS playback finishes.
     */
    @ReactMethod
    fun unmuteMic() {
        audioManager?.unmute()
    }

    @ReactMethod
    fun addListener(eventName: String?) {}

    @ReactMethod
    fun removeListeners(count: Int?) {}
}
