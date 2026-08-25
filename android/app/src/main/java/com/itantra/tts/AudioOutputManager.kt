package com.itantra.tts

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack

class AudioOutputManager {
    private var audioTrack: AudioTrack? = null
    var isPlaying: Boolean = false
        private set

    fun playPCM(audioData: ShortArray, sampleRate: Int = 22050) {
        stop()

        val bufferSize = AudioTrack.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        )

        audioTrack = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(sampleRate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build()
            )
            .setBufferSizeInBytes(bufferSize)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()

        audioTrack?.play()
        isPlaying = true
        audioTrack?.write(audioData, 0, audioData.size)
        isPlaying = false
        audioTrack?.stop()
        audioTrack?.release()
        audioTrack = null
    }

    fun stop() {
        isPlaying = false
        audioTrack?.let {
            if (it.state == AudioTrack.STATE_INITIALIZED) {
                it.pause()
                it.flush()
                it.stop()
            }
            it.release()
        }
        audioTrack = null
    }
}
