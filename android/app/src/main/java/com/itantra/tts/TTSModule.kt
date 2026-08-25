package com.itantra.tts

import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import kotlinx.coroutines.*

class TTSModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
    private val modelManager = TTSModelManager(reactContext)
    private val scope = CoroutineScope(Dispatchers.Default + Job())

    override fun getName(): String {
        return "NativeTTS"
    }

    private fun sendEvent(eventName: String, params: WritableMap?) {
        if (reactApplicationContext.hasActiveCatalystInstance()) {
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(eventName, params)
        }
    }

    @ReactMethod
    fun speak(text: String, language: String, isAlert: Boolean, promise: Promise) {
        val engine = modelManager.getEngine(language)
        
        val startParams = Arguments.createMap().apply {
            putString("text", text)
            putString("language", language)
        }
        sendEvent("TTS_STARTED", startParams)

        scope.launch {
            val startMs = System.currentTimeMillis()
            engine.speak(text, language)
            val durationMs = System.currentTimeMillis() - startMs

            val finishParams = Arguments.createMap().apply {
                putString("text", text)
                putString("language", language)
                putDouble("durationMs", durationMs.toDouble())
            }
            sendEvent("TTS_FINISHED", finishParams)
            promise.resolve(null)
        }
    }

    @ReactMethod
    fun stop(promise: Promise) {
        modelManager.getEngine("en").stop() 
        promise.resolve(null)
    }

    @ReactMethod
    fun addListener(eventName: String?) {
        // Required for RN built-in Event Emitter Calls
    }

    @ReactMethod
    fun removeListeners(count: Int?) {
        // Required for RN built-in Event Emitter Calls
    }

    override fun onCatalystInstanceDestroy() {
        super.onCatalystInstanceDestroy()
        scope.cancel()
        modelManager.release()
    }
}
