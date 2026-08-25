package com.itantra.stt

interface STTEngine {
    var onPartialResult: ((String) -> Unit)?
    var onFinalResult: ((STTResult) -> Unit)?
    var onError: ((String) -> Unit)?

    fun loadModel(modelPath: String, vocabPath: String? = null): Boolean
    fun startRecognition()
    fun feedChunk(data: ByteArray)
    fun getFinalResult()
    fun reset()
    fun release()
}

data class STTResult(
    val transcript: String,
    val confidence: Float,
    val language: String,
    val durationMs: Long
)
