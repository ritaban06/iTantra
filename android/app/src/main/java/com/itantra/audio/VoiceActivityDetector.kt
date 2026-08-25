package com.itantra.audio

import kotlin.math.abs

class VoiceActivityDetector {

    enum class State {
        SILENCE, PRE_SPEECH, SPEECH, POST_SPEECH
    }

    var currentState = State.SILENCE
        private set

    // Simple energy-based VAD for MVP
    private val ENERGY_THRESHOLD = 500
    private val SILENCE_THRESHOLD_MS = 500
    private val PRE_SPEECH_MS = 200

    private var silenceFrames = 0
    private var speechFrames = 0

    // Based on 16kHz, 512 frames per chunk (32ms per chunk)
    private val CHUNK_DURATION_MS = 32
    private val maxSilenceChunks = SILENCE_THRESHOLD_MS / CHUNK_DURATION_MS
    private val minSpeechChunks = PRE_SPEECH_MS / CHUNK_DURATION_MS

    fun processChunk(chunk: ShortArray): Boolean {
        val isLoud = computeEnergy(chunk) > ENERGY_THRESHOLD
        
        var stateChanged = false

        when (currentState) {
            State.SILENCE -> {
                if (isLoud) {
                    speechFrames++
                    if (speechFrames >= minSpeechChunks) {
                        currentState = State.SPEECH
                        stateChanged = true
                        speechFrames = 0
                    }
                } else {
                    speechFrames = 0
                }
            }
            State.SPEECH -> {
                if (!isLoud) {
                    silenceFrames++
                    if (silenceFrames >= maxSilenceChunks) {
                        currentState = State.SILENCE
                        stateChanged = true
                        silenceFrames = 0
                    }
                } else {
                    silenceFrames = 0
                }
            }
            else -> {}
        }
        
        return stateChanged
    }

    private fun computeEnergy(chunk: ShortArray): Double {
        var sum = 0L
        for (sample in chunk) {
            sum += abs(sample.toInt())
        }
        return if (chunk.isNotEmpty()) (sum / chunk.size.toDouble()) else 0.0
    }
    
    fun reset() {
        currentState = State.SILENCE
        silenceFrames = 0
        speechFrames = 0
    }
}
