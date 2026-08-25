package com.itantra.tts

import android.content.Context

class TTSModelManager(context: Context) {
    private val androidFallback = AndroidTTSFallback(context)

    fun getEngine(language: String): TTSEngine {
        // Phase 3A: Return AndroidTTSFallback for all requests
        return androidFallback
    }

    fun release() {
        androidFallback.release()
    }
}
