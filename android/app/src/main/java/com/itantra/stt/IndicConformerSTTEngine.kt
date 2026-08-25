package com.itantra.stt

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import com.itantra.audio.AudioPreprocessor
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer

class IndicConformerSTTEngine(private val context: Context, private val language: String) : STTEngine {
    private var env: OrtEnvironment? = null
    private var session: OrtSession? = null
    private var vocab: List<String> = emptyList()
    private val audioPreprocessor = AudioPreprocessor(context)
    private val audioBuffer = mutableListOf<Short>()
    private var isListening = false
    private var startMs = 0L

    override var onPartialResult: ((String) -> Unit)? = null
    override var onFinalResult: ((STTResult) -> Unit)? = null
    override var onError: ((String) -> Unit)? = null

    override fun loadModel(modelPath: String, vocabPath: String?): Boolean {
        try {
            env = OrtEnvironment.getEnvironment()
            val modelBytes = context.assets.open(modelPath).use { it.readBytes() }
            session = env?.createSession(modelBytes, OrtSession.SessionOptions())

            if (vocabPath != null) {
                val jsonStr = context.assets.open(vocabPath).bufferedReader().use { it.readText() }
                val array = JSONArray(jsonStr)
                vocab = List(array.length()) { i -> array.getString(i) }
            }
            return true
        } catch (e: Exception) {
            e.printStackTrace()
            onError?.invoke("Failed to load IndicConformer model: ${e.message}")
            return false
        }
    }

    override fun startRecognition() {
        audioBuffer.clear()
        isListening = true
        startMs = System.currentTimeMillis()
    }

    override fun feedChunk(data: ByteArray) {
        if (!isListening) return
        val shortArray = ShortArray(data.size / 2)
        ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(shortArray)
        audioBuffer.addAll(shortArray.toList())
    }

    override fun getFinalResult() {
        isListening = false
        if (audioBuffer.isEmpty() || session == null) return

        CoroutineScope(Dispatchers.Default).launch {
            try {
                val mel = audioPreprocessor.processAudio(audioBuffer.toShortArray())
                if (mel.isEmpty() || mel[0].isEmpty()) return@launch

                val timeFrames = mel[0].size
                val flattened = FloatArray(80 * timeFrames)
                var idx = 0
                for (m in 0 until 80) {
                    for (t in 0 until timeFrames) {
                        flattened[idx++] = mel[m][t]
                    }
                }

                val inputShape = longArrayOf(1, 80, timeFrames.toLong())
                val audioBufferFloat = FloatBuffer.wrap(flattened)
                val audioTensor = OnnxTensor.createTensor(env, audioBufferFloat, inputShape)

                val lengthTensor = OnnxTensor.createTensor(env, longArrayOf(timeFrames.toLong()))

                val inputs = mapOf("audio_signal" to audioTensor, "length" to lengthTensor)
                val outputs = session?.run(inputs)

                if (outputs != null) {
                    val logitsTensor = outputs[0] as OnnxTensor
                    val logits = logitsTensor.floatBuffer.array()
                    
                    val vPlusOne = vocab.size + 1
                    val tOut = logits.size / vPlusOne

                    val blankId = vocab.size
                    val tokens = java.lang.StringBuilder()
                    var previous = -1

                    for (t in 0 until tOut) {
                        var bestId = 0
                        var bestScore = Float.NEGATIVE_INFINITY
                        for (id in 0 until vPlusOne) {
                            val score = logits[t * vPlusOne + id]
                            if (score > bestScore) {
                                bestScore = score
                                bestId = id
                            }
                        }

                        if (bestId != previous) {
                            if (bestId != blankId && bestId < vocab.size) {
                                tokens.append(vocab[bestId])
                            }
                        }
                        previous = bestId
                    }

                    val transcript = tokens.toString().replace("▁", " ").trim()
                    val durationMs = System.currentTimeMillis() - startMs

                    audioTensor.close()
                    lengthTensor.close()
                    outputs.close()

                    withContext(Dispatchers.Main) {
                        onFinalResult?.invoke(STTResult(transcript, 1.0f, language, durationMs))
                    }
                }
            } catch (e: Exception) {
                e.printStackTrace()
                withContext(Dispatchers.Main) {
                    onError?.invoke("IndicConformer recognition error: ${e.message}")
                }
            }
        }
    }

    override fun reset() {
        audioBuffer.clear()
        isListening = false
    }

    override fun release() {
        session?.close()
        env?.close()
        session = null
        env = null
    }
}
