package com.itantra.stt

import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.itantra.audio.AudioCaptureManager
import com.itantra.audio.VoiceActivityDetector
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.nio.ByteBuffer
import java.nio.ByteOrder

class STTModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    private var sttEngine: STTEngine? = null
    private var audioManager: AudioCaptureManager? = null
    private val vad = VoiceActivityDetector()
    private var currentLanguage = "en"
    
    override fun getName() = "NativeSTT"

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
            EngineType.INDIC_CONFORMER -> sttEngine?.loadModel(config.modelPath, config.vocabPath)
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
        sttEngine?.release()
        sttEngine = null
        promise.resolve(true)
    }

    @ReactMethod
    fun isModelLoaded(language: String, promise: Promise) {
        promise.resolve(sttEngine != null && currentLanguage == language)
    }

    @ReactMethod
    fun cancelDownload() {
        ModelManager.isDownloadCancelled = true
    }

    @ReactMethod
    fun downloadModel(language: String, promise: Promise) {
        promise.resolve(true)
    }

    @ReactMethod
    fun startListening(language: String, promise: Promise) {
        if (sttEngine == null) {
            promise.reject("STT_FAILED", "Model not loaded. Call loadModel first.")
            return
        }

        vad.reset()
        sttEngine?.startRecognition()

        if (audioManager == null) {
            audioManager = AudioCaptureManager(
                onChunk = { chunk ->
                    val shortArray = ShortArray(chunk.size / 2)
                    ByteBuffer.wrap(chunk).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(shortArray)
                    
                    val stateChanged = vad.processChunk(shortArray)
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

                    sttEngine?.feedChunk(chunk)
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
        promise.resolve(true)
    }

    @ReactMethod
    fun addListener(eventName: String?) {}

    @ReactMethod
    fun removeListeners(count: Int?) {}
}
