package com.itantra.service

import com.facebook.react.bridge.*
import com.itantra.stt.STTModule
import com.itantra.tts.TTSModule

class NativeLocalLoopModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "NativeLocalLoop"

    @ReactMethod
    fun startLoop(language: String, promise: Promise) {
        val sttModule = STTModule.instance
        val ttsModule = TTSModule.instance

        if (sttModule == null || ttsModule == null) {
            promise.reject("MODULE_NOT_FOUND", "STT or TTS module not initialized. STT=${sttModule != null}, TTS=${ttsModule != null}")
            return
        }

        sttModule.onFinalResultIntercept = { transcript, confidence, lang ->
            if (confidence > 0.6) {
                sttModule.getAudioManager()?.mute()
                ttsModule.speakNative(transcript, lang,
                    onStart = {},
                    onFinish = {
                        sttModule.getAudioManager()?.unmute()
                    }
                )
            }
        }
        
        sttModule.startListening(language, promise)
    }

    @ReactMethod
    fun stopLoop(promise: Promise) {
        val sttModule = STTModule.instance
        sttModule?.onFinalResultIntercept = null
        sttModule?.stopListening(promise)
    }

    @ReactMethod
    fun teardown(promise: Promise) {
        val sttModule = STTModule.instance
        sttModule?.onFinalResultIntercept = null
        promise.resolve(null)
    }
}
