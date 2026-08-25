package com.itantra.audio

import android.content.Context
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.pow

class AudioPreprocessor(context: Context) {
    private val filters: Array<FloatArray>

    init {
        filters = loadMelFilterbank(context)
    }

    private fun loadMelFilterbank(context: Context): Array<FloatArray> {
        val bytes = context.assets
            .open("audio/mel_filters_80x257.bin")
            .use { it.readBytes() }
        require(bytes.size == 80 * 257 * 4) { "Invalid Mel filterbank size" }
        val buffer = ByteBuffer
            .wrap(bytes)
            .order(ByteOrder.LITTLE_ENDIAN)
        return Array(80) { FloatArray(257) { buffer.getFloat() } }
    }

    fun pcm16ToFloat(pcm: ShortArray): FloatArray {
        return FloatArray(pcm.size) { i -> pcm[i] / 32768.0f }
    }

    fun preEmphasis(audio: FloatArray, coefficient: Float = 0.97f): FloatArray {
        if (audio.isEmpty()) return FloatArray(0)
        val output = FloatArray(audio.size)
        output[0] = audio[0]
        for (i in 1 until audio.size) {
            output[i] = audio[i] - coefficient * audio[i - 1]
        }
        return output
    }

    fun processAudio(pcm: ShortArray): Array<FloatArray> {
        val floatAudio = pcm16ToFloat(pcm)
        val preEmphasized = preEmphasis(floatAudio)
        
        val nFft = 512
        val winLength = 400
        val hopLength = 160
        
        // Hann window
        val window = FloatArray(winLength) { i ->
            (0.5 - 0.5 * cos(2.0 * PI * i / (winLength - 1))).toFloat()
        }

        val numFrames = 1 + (preEmphasized.size - winLength) / hopLength
        val framesCount = kotlin.math.max(0, numFrames)
        
        val powerSpectrogram = Array(257) { FloatArray(framesCount) }

        val real = FloatArray(nFft)
        val imag = FloatArray(nFft)

        for (t in 0 until framesCount) {
            val offset = t * hopLength
            for (i in 0 until nFft) {
                if (i < winLength && offset + i < preEmphasized.size) {
                    real[i] = preEmphasized[offset + i] * window[i]
                } else {
                    real[i] = 0f
                }
                imag[i] = 0f
            }

            fft(real, imag)

            for (k in 0..256) {
                powerSpectrogram[k][t] = real[k] * real[k] + imag[k] * imag[k]
            }
        }

        val mel = applyMelFilterbank(powerSpectrogram, filters)
        
        val epsilon = (2.0).pow(-24.0).toFloat()
        for (m in 0 until 80) {
            for (t in 0 until framesCount) {
                mel[m][t] = kotlin.math.ln(mel[m][t] + epsilon)
            }
        }

        normalizeMel(mel)
        return mel
    }

    private fun applyMelFilterbank(power: Array<FloatArray>, filters: Array<FloatArray>): Array<FloatArray> {
        if (power.isEmpty() || power[0].isEmpty()) return Array(80) { FloatArray(0) }
        val numFrames = power[0].size
        val mel = Array(80) { FloatArray(numFrames) }
        for (m in 0 until 80) {
            for (t in 0 until numFrames) {
                var sum = 0.0f
                for (k in 0 until 257) {
                    sum += filters[m][k] * power[k][t]
                }
                mel[m][t] = sum
            }
        }
        return mel
    }

    private fun normalizeMel(mel: Array<FloatArray>) {
        if (mel.isEmpty() || mel[0].size <= 1) return
        val bins = mel.size
        for (bin in 0 until bins) {
            val frames = mel[bin]
            var sum = 0.0f
            for (value in frames) {
                sum += value
            }
            val mean = sum / frames.size
            var variance = 0.0f
            for (value in frames) {
                val diff = value - mean
                variance += diff * diff
            }
            val std = kotlin.math.sqrt((variance / (frames.size - 1)).toDouble()).toFloat()
            for (i in frames.indices) {
                frames[i] = (frames[i] - mean) / (std + 1e-5f)
            }
        }
    }

    private fun fft(real: FloatArray, imag: FloatArray) {
        val n = real.size
        var j = 0
        for (i in 0 until n - 1) {
            if (i < j) {
                var temp = real[i]
                real[i] = real[j]
                real[j] = temp
                temp = imag[i]
                imag[i] = imag[j]
                imag[j] = temp
            }
            var k = n / 2
            while (k <= j) {
                j -= k
                k /= 2
            }
            j += k
        }

        var l1 = 1
        var l2 = 2
        while (l2 <= n) {
            val c = cos(-2.0 * PI / l2).toFloat()
            val s = sin(-2.0 * PI / l2).toFloat()
            for (i in 0 until n step l2) {
                var u1 = 1.0f
                var u2 = 0.0f
                for (k in 0 until l1) {
                    val j1 = i + k
                    val j2 = j1 + l1
                    val t1 = u1 * real[j2] - u2 * imag[j2]
                    val t2 = u1 * imag[j2] + u2 * real[j2]
                    real[j2] = real[j1] - t1
                    imag[j2] = imag[j1] - t2
                    real[j1] += t1
                    imag[j1] += t2
                    val z = u1 * c - u2 * s
                    u2 = u1 * s + u2 * c
                    u1 = z
                }
            }
            l1 = l2
            l2 *= 2
        }
    }
}
