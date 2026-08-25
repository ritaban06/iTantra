package com.itantra.tts

interface TTSEngine {
    suspend fun speak(text: String, language: String)
    fun stop()
    fun isAvailable(language: String): Boolean
    fun release()
}
