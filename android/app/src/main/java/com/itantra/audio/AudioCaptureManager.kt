package com.itantra.audio

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import kotlinx.coroutines.*
import java.nio.ByteBuffer
import java.nio.ByteOrder

class AudioCaptureManager(
    private val onChunk: (ByteArray) -> Unit,
    private val onError: (String) -> Unit
) {
    private var audioRecord: AudioRecord? = null
    private var isRecording = false
    private var captureJob: Job? = null
    
    private val SAMPLE_RATE = 16000
    private val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO
    private val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT
    private val BUFFER_SIZE = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT) * 2

    @SuppressLint("MissingPermission")
    fun startCapture() {
        if (isRecording) return

        try {
            audioRecord = AudioRecord(
                MediaRecorder.AudioSource.MIC,
                SAMPLE_RATE,
                CHANNEL_CONFIG,
                AUDIO_FORMAT,
                BUFFER_SIZE
            )

            if (audioRecord?.state != AudioRecord.STATE_INITIALIZED) {
                onError("AudioRecord failed to initialize")
                return
            }

            audioRecord?.startRecording()
            isRecording = true

            captureJob = CoroutineScope(Dispatchers.IO).launch {
                val buffer = ByteArray(4096) // 2048 samples at 16-bit
                while (isRecording && isActive) {
                    val readResult = audioRecord?.read(buffer, 0, buffer.size) ?: 0
                    if (readResult > 0) {
                        val chunk = buffer.copyOf(readResult)
                        withContext(Dispatchers.Default) {
                            onChunk(chunk)
                        }
                    } else if (readResult < 0) {
                        withContext(Dispatchers.Main) {
                            onError("AudioRecord read error: $readResult")
                        }
                    }
                }
            }
        } catch (e: Exception) {
            onError(e.message ?: "Unknown audio capture error")
        }
    }

    fun stopCapture() {
        if (!isRecording) return
        isRecording = false
        captureJob?.cancel()
        captureJob = null
        
        try {
            audioRecord?.stop()
            audioRecord?.release()
        } catch (e: Exception) {
            // Ignore stop errors
        } finally {
            audioRecord = null
        }
    }
}
