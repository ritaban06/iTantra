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

    private var sttEngine: VoskSTTEngine? = null
    private var audioManager: AudioCaptureManager? = null
    private val vad = VoiceActivityDetector()
    private var currentLanguage = "en"
    
    override fun getName() = "NativeSTT"

    private fun emitEvent(eventName: String, params: WritableMap?) {
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, params)
    }

    @ReactMethod
    fun loadModel(language: String, promise: Promise) {
        val modelPath = ModelManager.getModelPath(reactApplicationContext, language)
        if (modelPath == null) {
            promise.reject("MODEL_NOT_FOUND", "Model for language $language not found locally.")
            return
        }

        sttEngine?.release()
        sttEngine = VoskSTTEngine(modelPath).apply {
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

        if (sttEngine?.loadModel() == true) {
            currentLanguage = language
            promise.resolve(true)
        } else {
            promise.reject("MODEL_LOAD_FAILED", "Failed to initialize Vosk model.")
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
        ModelManager.isDownloadCancelled = false
        CoroutineScope(Dispatchers.IO).launch {
            try {
                ModelManager.downloadAndUnzipModel(reactApplicationContext, language) { progress ->
                    val map = Arguments.createMap().apply {
                        putString("language", language)
                        putInt("progress", progress)
                    }
                    emitEvent("STT_DOWNLOAD_PROGRESS", map)
                }
                withContext(Dispatchers.Main) {
                    promise.resolve(true)
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    promise.reject("DOWNLOAD_FAILED", e.message)
                }
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

        if (audioManager == null) {
            audioManager = AudioCaptureManager(
                onChunk = { chunk ->
                    // Convert ByteArray to ShortArray for VAD
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

                    // For simplicity, we feed everything to STT if we started listening,
                    // or we could optimize by only feeding during PRE_SPEECH / SPEECH
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
}
