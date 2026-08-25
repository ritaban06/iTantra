package com.itantra.stt

import org.vosk.Model
import org.vosk.Recognizer
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject

class VoskSTTEngine(private val modelPath: String) : STTEngine {

    private var model: Model? = null
    private var recognizer: Recognizer? = null
    private var isLoaded = false
    private val scope = CoroutineScope(Dispatchers.Default)
    private var processingJob: Job? = null
    private val mutex = Mutex()

    override var onPartialResult: ((String) -> Unit)? = null
    override var onFinalResult: ((STTResult) -> Unit)? = null
    override var onError: ((String) -> Unit)? = null

    override fun loadModel(modelPath: String, vocabPath: String?): Boolean {
        if (isLoaded) return true
        try {
            model = Model(this.modelPath)
            recognizer = Recognizer(model, 16000.0f)
            isLoaded = true
            return true
        } catch (e: Exception) {
            onError?.invoke("Failed to load model from $modelPath: ${e.message}")
            return false
        }
    }

    override fun startRecognition() {
        if (!isLoaded) {
            onError?.invoke("Model not loaded yet")
            return
        }
        scope.launch {
            mutex.withLock {
                recognizer?.reset()
            }
        }
    }

    override fun feedChunk(data: ByteArray) {
        if (!isLoaded || recognizer == null) return
        
        processingJob = scope.launch {
            mutex.withLock {
                if (recognizer == null) return@withLock
                try {
                    val done = recognizer!!.acceptWaveForm(data, data.size)
                    if (done) {
                        val resultJson = recognizer!!.result
                        val parsed = parseFinalResult(resultJson)
                        withContext(Dispatchers.Main) {
                            if (parsed != null) onFinalResult?.invoke(parsed)
                        }
                    } else {
                        val partialJson = recognizer!!.partialResult
                        val partial = parsePartialResult(partialJson)
                        withContext(Dispatchers.Main) {
                            onPartialResult?.invoke(partial)
                        }
                    }
                } catch (e: Exception) {
                    withContext(Dispatchers.Main) {
                        onError?.invoke("Recognition error: ${e.message}")
                    }
                }
            }
        }
    }

    override fun getFinalResult() {
        if (!isLoaded || recognizer == null) return
        
        scope.launch {
            mutex.withLock {
                if (recognizer == null) return@withLock
                try {
                    val finalJson = recognizer!!.finalResult
                    val parsed = parseFinalResult(finalJson)
                    withContext(Dispatchers.Main) {
                        if (parsed != null) onFinalResult?.invoke(parsed)
                    }
                } catch (e: Exception) {
                    withContext(Dispatchers.Main) {
                        onError?.invoke("Recognition error: ${e.message}")
                    }
                }
            }
        }
    }

    private fun parsePartialResult(jsonStr: String): String {
        return try {
            JSONObject(jsonStr).optString("partial", "")
        } catch (e: Exception) {
            ""
        }
    }

    private fun parseFinalResult(jsonStr: String): STTResult? {
        return try {
            val json = JSONObject(jsonStr)
            val text = json.optString("text", "")
            if (text.isEmpty()) return null
            
            // Vosk doesn't provide easy confidence in the simple API without alternatives,
            // for MVP we mock confidence based on text presence (or we'd parse alternatives)
            val confidence = 0.9f // Placeholder
            
            STTResult(text, confidence, "", 0)
        } catch (e: Exception) {
            null
        }
    }

    override fun reset() {
        scope.launch {
            mutex.withLock {
                recognizer?.reset()
            }
        }
    }

    override fun release() {
        processingJob?.cancel()
        scope.launch {
            mutex.withLock {
                recognizer?.close()
                model?.close()
                recognizer = null
                model = null
                isLoaded = false
            }
        }
    }
}


