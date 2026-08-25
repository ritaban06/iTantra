package com.itantra.tts

import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import java.util.Locale
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine

class AndroidTTSFallback(private val context: Context) : TTSEngine, TextToSpeech.OnInitListener {
    private var tts: TextToSpeech? = null
    private var isInitialized = false

    init {
        tts = TextToSpeech(context, this)
    }

    override fun onInit(status: Int) {
        if (status == TextToSpeech.SUCCESS) {
            isInitialized = true
            Log.d("AndroidTTSFallback", "TTS Initialization succeeded")
        } else {
            Log.e("AndroidTTSFallback", "TTS Initialization failed")
        }
    }

    override suspend fun speak(text: String, language: String): Unit = suspendCoroutine { continuation ->
        if (!isInitialized || tts == null) {
            Log.e("AndroidTTSFallback", "TTS not initialized")
            continuation.resume(Unit)
            return@suspendCoroutine
        }

        val locale = when (language) {
            "en" -> Locale("en", "IN")
            "hi" -> Locale("hi", "IN")
            "bn" -> Locale("bn", "IN")
            else -> Locale(language)
        }

        val result = tts?.setLanguage(locale)
        if (result == TextToSpeech.LANG_MISSING_DATA || result == TextToSpeech.LANG_NOT_SUPPORTED) {
            Log.e("AndroidTTSFallback", "Language not supported: $language")
            continuation.resume(Unit)
            return@suspendCoroutine
        }

        val utteranceId = "utterance_${System.currentTimeMillis()}"

        tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {}

            override fun onDone(utteranceId: String?) {
                continuation.resume(Unit)
            }

            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) {
                continuation.resume(Unit)
            }
        })

        tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId)
    }

    override fun stop() {
        tts?.stop()
    }

    override fun isAvailable(language: String): Boolean {
        if (!isInitialized || tts == null) return false
        val locale = when (language) {
            "en" -> Locale("en", "IN")
            "hi" -> Locale("hi", "IN")
            "bn" -> Locale("bn", "IN")
            else -> Locale(language)
        }
        val result = tts?.isLanguageAvailable(locale)
        return result != TextToSpeech.LANG_MISSING_DATA && result != TextToSpeech.LANG_NOT_SUPPORTED
    }

    override fun release() {
        tts?.stop()
        tts?.shutdown()
        tts = null
    }
}
