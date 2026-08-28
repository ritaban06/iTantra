package com.itantra.audio

import org.junit.Assert.*
import org.junit.Test

/**
 * Unit tests for DeepFilterConfig constants.
 *
 * These values are verified against the actual DPDFNet2 ONNX model graph:
 *   dpdfnet2.onnx — opset 17, 16 kHz, FP32
 *   Input spec: [1, 1, 161, 2]  → NUM_FREQ_BINS = 161
 *   Input state: [45424]         → STATE_SIZE = 45424
 *   Frame: 320 samples (20 ms @ 16 kHz)
 *   Hop:   160 samples (10 ms @ 16 kHz)
 */
class DeepFilterConfigTest {

    @Test
    fun `fft size is 320`() {
        assertEquals(320, DeepFilterConfig.FFT_SIZE)
    }

    @Test
    fun `hop size is 160`() {
        assertEquals(160, DeepFilterConfig.HOP_SIZE)
    }

    @Test
    fun `hop size is half of fft size (50% overlap)`() {
        assertEquals(DeepFilterConfig.FFT_SIZE / 2, DeepFilterConfig.HOP_SIZE)
    }

    @Test
    fun `number of frequency bins is 161`() {
        assertEquals(161, DeepFilterConfig.NUM_FREQ_BINS)
    }

    @Test
    fun `frequency bins equals fft_size div 2 plus 1`() {
        assertEquals(DeepFilterConfig.FFT_SIZE / 2 + 1, DeepFilterConfig.NUM_FREQ_BINS)
    }

    @Test
    fun `state size is 45424`() {
        assertEquals(45424, DeepFilterConfig.STATE_SIZE)
    }

    @Test
    fun `state size in bytes is 177696`() {
        // 45424 floats * 4 bytes = 181696 bytes = 177.4 KB
        assertEquals(45424 * 4, DeepFilterConfig.STATE_SIZE * 4)
    }

    @Test
    fun `sample rate is 16000`() {
        assertEquals(16000, DeepFilterConfig.SAMPLE_RATE)
    }

    @Test
    fun `fft size covers 20ms at 16kHz`() {
        // 320 samples / 16000 Hz = 0.020s = 20ms
        val durationMs = DeepFilterConfig.FFT_SIZE * 1000.0 / DeepFilterConfig.SAMPLE_RATE
        assertEquals(20.0, durationMs, 0.001)
    }

    @Test
    fun `hop size covers 10ms at 16kHz`() {
        // 160 samples / 16000 Hz = 0.010s = 10ms
        val durationMs = DeepFilterConfig.HOP_SIZE * 1000.0 / DeepFilterConfig.SAMPLE_RATE
        assertEquals(10.0, durationMs, 0.001)
    }

    @Test
    fun `model asset path is set`() {
        assertNotNull(DeepFilterConfig.MODEL_ASSET_PATH)
        assertTrue(DeepFilterConfig.MODEL_ASSET_PATH.endsWith(".onnx"))
    }

    @Test
    fun `onnx tensor names are set`() {
        assertNotNull(DeepFilterConfig.INPUT_SPEC_NAME)
        assertNotNull(DeepFilterConfig.INPUT_STATE_NAME)
        assertNotNull(DeepFilterConfig.OUTPUT_SPEC_NAME)
        assertNotNull(DeepFilterConfig.OUTPUT_STATE_NAME)
    }

    @Test
    fun `default enabled is true`() {
        assertTrue(DeepFilterConfig.DEFAULT_ENABLED)
    }
}
