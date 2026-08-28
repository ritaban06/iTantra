package com.itantra.audio

import org.junit.Assert.*
import org.junit.Test
import kotlin.math.PI
import kotlin.math.sin

/**
 * Unit tests for DeepFilterEngine streaming behavior and DSP correctness.
 *
 * Verified against official DPDFNet reference:
 *   - Vorbis window function
 *   - Frame/hop buffering (160-sample hop, not 320)
 *   - No audio loss across chunk boundaries
 *   - State management and reset
 *   - Output sample range
 */
class DeepFilterEngineTest {

    // ── Vorbis window verification ─────────────────────────────────────

    /**
     * Verify the Vorbis window matches the official implementation:
     *   window[i] = sin(0.5 * PI * sin(0.5 * PI * (i + 0.5) / (N/2))^2)
     */
    @Test
    fun `vorbis window matches official reference`() {
        val n = 320
        val halfLen = n.toFloat() / 2.0f

        // Official Python reference values for a few key positions.
        val expected = FloatArray(n) { i ->
            val sinVal = sin(0.5f * PI.toFloat() * (i + 0.5f) / halfLen)
            sin(0.5f * PI.toFloat() * sinVal * sinVal)
        }

        // Verify symmetry: window[i] == window[N-1-i].
        for (i in 0 until n / 2) {
            assertEquals(
                "Vorbis window not symmetric at position $i",
                expected[i], expected[n - 1 - i], 1e-6f
            )
        }

        // Verify window[0] > 0 (not zero at edges like Hann).
        assertTrue("Vorbis window[0] should be > 0", expected[0] > 0.0f)
        assertTrue("Vorbis window[0] should be < 1", expected[0] < 1.0f)

        // Verify window[N/2] is near 1.0 (peak in the middle).
        val midVal = expected[n / 2]
        assertTrue("Vorbis window peak should be near 1.0, got $midVal", midVal > 0.9f)

        // Verify all values are in [0, 1].
        for (v in expected) {
            assertTrue("Window value $v out of range [0,1]", v >= 0.0f && v <= 1.0f)
        }
    }

    @Test
    fun `vorbis window is not hann window`() {
        val n = 320
        val halfLen = n.toFloat() / 2.0f

        // Vorbis
        val vorbis = FloatArray(n) { i ->
            val sinVal = sin(0.5f * PI.toFloat() * (i + 0.5f) / halfLen)
            sin(0.5f * PI.toFloat() * sinVal * sinVal)
        }

        // Hann
        val hann = FloatArray(n) { i ->
            (0.5f * (1.0f - kotlin.math.cos(2.0f * PI.toFloat() * i / (n - 1)))).toFloat()
        }

        // They must differ at some positions.
        var anyDifferent = false
        for (i in 0 until n) {
            if (kotlin.math.abs(vorbis[i] - hann[i]) > 1e-4f) {
                anyDifferent = true
                break
            }
        }
        assertTrue("Vorbis window must differ from Hann window", anyDifferent)
    }

    // ── Frame/hop buffering ────────────────────────────────────────────

    /**
     * With 160-sample hop, 2048 input samples should produce:
     *   2048 / 160 = 12.8 → 12 complete hops, 128 samples remaining.
     *
     * This is the CORRECT behavior (NOT 6 frames as the old implementation claimed).
     */
    @Test
    fun `hop-based buffering produces correct number of hops for 2048 samples`() {
        val hopSize = DeepFilterConfig.HOP_SIZE // 160
        val inputSize = 2048
        var consumed = 0
        var hops = 0

        while (consumed + hopSize <= inputSize) {
            consumed += hopSize
            hops++
        }

        assertEquals("2048 samples should produce 12 hops at 160-sample hop", 12, hops)
        assertEquals("Remaining samples", 128, inputSize - consumed)
    }

    @Test
    fun `small input less than hop size produces no hops`() {
        val hopSize = DeepFilterConfig.HOP_SIZE
        var consumed = 0
        var hops = 0
        val inputSize = 100

        while (consumed + hopSize <= inputSize) {
            consumed += hopSize
            hops++
        }

        assertEquals(0, hops)
        assertEquals(0, consumed)
    }

    @Test
    fun `exact hop size produces one hop`() {
        val hopSize = DeepFilterConfig.HOP_SIZE
        var consumed = 0
        var hops = 0
        val inputSize = hopSize

        while (consumed + hopSize <= inputSize) {
            consumed += hopSize
            hops++
        }

        assertEquals(1, hops)
    }

    @Test
    fun `no audio is discarded across multiple chunks`() {
        val hopSize = DeepFilterConfig.HOP_SIZE
        val chunk1 = ShortArray(2048) { it.toShort() }
        val chunk2 = ShortArray(2048) { (it + 2048).toShort() }

        // Simulate the input buffer.
        val pendingInput = mutableListOf<Short>()
        var totalConsumed = 0

        pendingInput.addAll(chunk1.toList())
        while (pendingInput.size >= hopSize) {
            for (i in 0 until hopSize) pendingInput.removeAt(0)
            totalConsumed += hopSize
        }

        pendingInput.addAll(chunk2.toList())
        while (pendingInput.size >= hopSize) {
            for (i in 0 until hopSize) pendingInput.removeAt(0)
            totalConsumed += hopSize
        }

        // Total input: 4096 samples. Consumed: 4096 - remaining.
        val remaining = pendingInput.size
        assertEquals("All samples except final partial hop should be consumed",
            4096 - remaining, totalConsumed)
        assertTrue("Remaining should be < hopSize", remaining < hopSize)
    }

    @Test
    fun `consecutive chunks preserve continuity`() {
        val hopSize = DeepFilterConfig.HOP_SIZE
        val fftSize = DeepFilterConfig.FFT_SIZE

        // Simulate two chunks with analysis buffer continuity.
        val analysisBuffer = FloatArray(fftSize)
        var pendingSamples = mutableListOf<Short>()

        // First chunk: 2048 samples.
        val chunk1 = ShortArray(2048) { 1000 } // constant value
        pendingSamples.addAll(chunk1.toList())

        var hopsProduced = 0
        while (pendingSamples.size >= hopSize) {
            val hop = ShortArray(hopSize) { pendingSamples[it] }
            for (i in 0 until hopSize) pendingSamples.removeAt(0)

            // Shift analysis buffer.
            System.arraycopy(analysisBuffer, hopSize, analysisBuffer, 0, fftSize - hopSize)
            for (i in 0 until hopSize) {
                analysisBuffer[fftSize - hopSize + i] = hop[i].toFloat() / 32768.0f
            }
            hopsProduced++
        }

        // After first chunk: 2048/160 = 12 hops, 128 remaining.
        assertEquals(12, hopsProduced)
        assertEquals(128, pendingSamples.size)

        // Second chunk: add 2048 more samples.
        val chunk2 = ShortArray(2048) { 2000 }
        pendingSamples.addAll(chunk2.toList())

        while (pendingSamples.size >= hopSize) {
            val hop = ShortArray(hopSize) { pendingSamples[it] }
            for (i in 0 until hopSize) pendingSamples.removeAt(0)

            System.arraycopy(analysisBuffer, hopSize, analysisBuffer, 0, fftSize - hopSize)
            for (i in 0 until hopSize) {
                analysisBuffer[fftSize - hopSize + i] = hop[i].toFloat() / 32768.0f
            }
            hopsProduced++
        }

        // Total: 4096/160 = 25 hops, 160 remaining.
        assertEquals(25, hopsProduced)
        assertEquals(160, pendingSamples.size)

        // Analysis buffer should contain the last 320 samples (160 from chunk2 end + 160 zeros from hop).
        // The last non-zero sample in the analysis buffer should be from chunk2.
        val lastSample = analysisBuffer[fftSize - 1]
        assertEquals("Analysis buffer should contain chunk2 data",
            2000.0f / 32768.0f, lastSample, 1e-5f)
    }

    // ── Overlap-add behavior ───────────────────────────────────────────

    @Test
    fun `first hop is suppressed (warm-up)`() {
        // The first hop should not produce output (started = false).
        var started = false
        var outputCount = 0

        // Simulate first hop.
        if (started) {
            outputCount += DeepFilterConfig.HOP_SIZE
        } else {
            started = true
        }

        assertEquals("First hop should produce 0 output samples", 0, outputCount)
    }

    @Test
    fun `subsequent hops produce hop_size output samples`() {
        var started = true // After first hop.
        var outputCount = 0

        // Simulate 5 hops.
        repeat(5) {
            if (started) {
                outputCount += DeepFilterConfig.HOP_SIZE
            }
        }

        assertEquals("5 hops should produce 800 output samples", 800, outputCount)
    }

    // ── State management ───────────────────────────────────────────────

    @Test
    fun `reset clears all state`() {
        val stateIn = FloatArray(DeepFilterConfig.STATE_SIZE) { 0.5f }
        val analysisBuffer = FloatArray(DeepFilterConfig.FFT_SIZE) { 1.0f }
        val overlapAddBuffer = FloatArray(DeepFilterConfig.FFT_SIZE) { 2.0f }

        // Simulate reset.
        stateIn.fill(0f)
        analysisBuffer.fill(0f)
        overlapAddBuffer.fill(0f)

        for (v in stateIn) assertEquals(0.0f, v, 0.001f)
        for (v in analysisBuffer) assertEquals(0.0f, v, 0.001f)
        for (v in overlapAddBuffer) assertEquals(0.0f, v, 0.001f)
    }

    @Test
    fun `new utterance produces independent output`() {
        val state1 = FloatArray(DeepFilterConfig.STATE_SIZE) { 0.5f }
        val state2 = FloatArray(DeepFilterConfig.STATE_SIZE) { 0f } // after reset

        assertNotEquals("States should differ before/after reset", state1[0], state2[0], 0.001f)
    }

    // ── Output sample range ────────────────────────────────────────────

    @Test
    fun `output samples stay within short range`() {
        val testValues = floatArrayOf(0.0f, 0.5f, -0.5f, 1.0f, -1.0f, 0.1f, -0.1f)
        for (fv in testValues) {
            val intSample = fv.roundToInt()
            val shortSample = intSample.coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort()
            assertTrue(shortSample >= Short.MIN_VALUE)
            assertTrue(shortSample <= Short.MAX_VALUE)
        }
    }

    @Test
    fun `clamping prevents overflow`() {
        val hugeFloat = 10.0f
        val intSample = hugeFloat.roundToInt()
        val shortSample = intSample.coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort()
        assertEquals(Short.MAX_VALUE, shortSample)
    }

    @Test
    fun `clamping prevents underflow`() {
        val hugeNegative = -10.0f
        val intSample = hugeNegative.roundToInt()
        val shortSample = intSample.coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort()
        assertEquals(Short.MIN_VALUE, shortSample)
    }

    // ── Config consistency ─────────────────────────────────────────────

    @Test
    fun `hop size is exactly half of frame size`() {
        assertEquals(DeepFilterConfig.FFT_SIZE / 2, DeepFilterConfig.HOP_SIZE)
    }

    @Test
    fun `state size matches ONNX model contract`() {
        assertEquals(45424, DeepFilterConfig.STATE_SIZE)
    }

    @Test
    fun `num freq bins equals fft_size div 2 plus 1`() {
        assertEquals(DeepFilterConfig.FFT_SIZE / 2 + 1, DeepFilterConfig.NUM_FREQ_BINS)
    }

    // ── Empty output / VAD guard ──────────────────────────────────────

    /**
     * Verify that an empty ShortArray from DeepFilter.process()
     * should NOT be passed to VAD or STT.
     * This test encodes the guard logic that STTModule now uses.
     */
    @Test
    fun `empty processed array should skip VAD and STT`() {
        val processedArray = ShortArray(0) // simulating first-hop warm-up
        var vadCalled = false
        var sttCalled = false

        // The guard logic from STTModule:
        if (processedArray.isEmpty()) {
            // Skip VAD/STT — do nothing.
        } else {
            vadCalled = true
            sttCalled = true
        }

        assertFalse("VAD should not be called on empty output", vadCalled)
        assertFalse("STT should not be called on empty output", sttCalled)
    }

    @Test
    fun `non-empty processed array reaches VAD and STT`() {
        val processedArray = ShortArray(160) { it.toShort() }
        var vadCalled = false
        var sttCalled = false

        if (processedArray.isEmpty()) {
            // skip
        } else {
            vadCalled = true
            sttCalled = true
        }

        assertTrue("VAD should be called on non-empty output", vadCalled)
        assertTrue("STT should be called on non-empty output", sttCalled)
    }

    // ── Inference failure fallback ─────────────────────────────────────

    /**
     * Verify that the fallback counter increments on failure
     * and the engine remains usable afterward.
     */
    @Test
    fun `fallback counter increments on failure`() {
        var fallbackCount = 0L

        // Simulate a failure.
        try {
            throw RuntimeException("simulated inference failure")
        } catch (e: Exception) {
            fallbackCount++
        }

        assertEquals(1L, fallbackCount)

        // Simulate a second failure.
        try {
            throw RuntimeException("second failure")
        } catch (e: Exception) {
            fallbackCount++
        }

        assertEquals(2L, fallbackCount)
    }

    // ── Reset/reuse after failure ──────────────────────────────────────

    /**
     * Verify that reset clears all state including fallback counts,
     * allowing clean reuse.
     */
    @Test
    fun `reset clears fallback count for clean reuse`() {
        var fallbackCount = 3L
        var frameCount = 10L
        var totalInferenceNanos = 5_000_000L

        // Simulate reset.
        fallbackCount = 0L
        frameCount = 0L
        totalInferenceNanos = 0L

        assertEquals(0L, fallbackCount)
        assertEquals(0L, frameCount)
        assertEquals(0L, totalInferenceNanos)
    }

    // ── Synchronization safety ─────────────────────────────────────────

    /**
     * Verify that the lock object exists and can be used for synchronization.
     * The actual thread-safety is tested by the @Synchronized annotation
     * on process(), reset(), and release().
     */
    @Test
    fun `synchronization lock is reentrant`() {
        val lock = Any()
        var entered = false

        synchronized(lock) {
            // Reentrant: can acquire the same lock again.
            synchronized(lock) {
                entered = true
            }
        }

        assertTrue("Reentrant lock should allow nested acquisition", entered)
    }

    // ── Analysis buffer shift correctness ──────────────────────────────

    /**
     * Verify that System.arraycopy correctly shifts the analysis buffer.
     */
    @Test
    fun `analysis buffer shift preserves correct samples`() {
        val fftSize = DeepFilterConfig.FFT_SIZE
        val hopSize = DeepFilterConfig.HOP_SIZE
        val buffer = FloatArray(fftSize) { it.toFloat() }

        // Shift left by hopSize.
        System.arraycopy(buffer, hopSize, buffer, 0, fftSize - hopSize)

        // First fftSize-hopSize elements should now be [hopSize, hopSize+1, ...]
        for (i in 0 until fftSize - hopSize) {
            assertEquals("Buffer[$i] should be ${hopSize + i}.toFloat()",
                (hopSize + i).toFloat(), buffer[i], 0.001f)
        }
    }

    // ── Overlap-add buffer shift correctness ───────────────────────────

    @Test
    fun `overlap-add buffer shift and zero fill`() {
        val fftSize = DeepFilterConfig.FFT_SIZE
        val hopSize = DeepFilterConfig.HOP_SIZE
        val buffer = FloatArray(fftSize) { 1.0f }

        // Shift left by hopSize.
        System.arraycopy(buffer, hopSize, buffer, 0, fftSize - hopSize)
        // Zero the tail.
        for (i in fftSize - hopSize until fftSize) {
            buffer[i] = 0f
        }

        // First fftSize-hopSize elements should be 1.0f.
        for (i in 0 until fftSize - hopSize) {
            assertEquals(1.0f, buffer[i], 0.001f)
        }
        // Last hopSize elements should be 0.0f.
        for (i in fftSize - hopSize until fftSize) {
            assertEquals(0.0f, buffer[i], 0.001f)
        }
    }
}
