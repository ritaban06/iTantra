/**
 * V6B Transport Envelope — Tests
 *
 * Comprehensive tests for V6BFrameCodec, SequenceManager, and SequenceValidator.
 */

import { SemanticMessage } from '../../semantic/SemanticMessageTypes';
import { encode as v6aEncode } from '../BinaryMessageCodec';
import {
  encode,
  decode,
  safeDecode,
  validateFrame,
} from '../V6BFrameCodec';
import {
  V6B_VERSION,
  V6B_FRAME_V6A_MESSAGE,
  V6B_FRAME_ACK,
  V6B_FRAME_NACK,
  V6B_FRAME_PING,
  V6B_FRAME_PONG,
  V6B_HEADER_SIZE,
  V6B_MAX_FRAME_SIZE,
  V6B_MAX_PAYLOAD_SIZE,
  V6BFrameError,
} from '../V6BFrameTypes';
import { SequenceManager } from '../SequenceManager';
import { SequenceValidator } from '../SequenceValidator';

// ── Test Helpers ──────────────────────────────────────────────────

function makeV6aMessage(overrides: Partial<SemanticMessage> = {}): SemanticMessage {
  return {
    version: 1,
    messageId: 'msg_test_v6b_00',
    text: 'Hello judges',
    language: 'en',
    emotion: 'neutral',
    emotionConfidence: 0.0,
    voiceProfile: 'default',
    ...overrides,
  };
}

function makePayload(n: number): Uint8Array {
  return new Uint8Array(n).fill(0x41); // 'A' bytes
}

// ══════════════════════════════════════════════════════════════════
// 1–20. FRAME CODEC TESTS
// ══════════════════════════════════════════════════════════════════

describe('V6BFrameCodec', () => {
  describe('encode / decode round trip', () => {
    // Test 1: encode V6A message
    it('encodes a V6A_MESSAGE frame', () => {
      const payload = makePayload(30);
      const frame = encode(0, V6B_FRAME_V6A_MESSAGE, payload);
      expect(frame).toBeInstanceOf(Uint8Array);
      expect(frame.length).toBe(V6B_HEADER_SIZE + 30);
    });

    // Test 2: decode V6A message
    it('decodes a V6A_MESSAGE frame', () => {
      const payload = makePayload(30);
      const frame = encode(5, V6B_FRAME_V6A_MESSAGE, payload);
      const decoded = decode(frame);
      expect(decoded.version).toBe(V6B_VERSION);
      expect(decoded.frameType).toBe(V6B_FRAME_V6A_MESSAGE);
      expect(decoded.sequence).toBe(5);
      expect(decoded.payloadLength).toBe(30);
      expect(decoded.payload.length).toBe(30);
    });

    // Test 3: version byte
    it('writes version byte 0x03 at offset 0', () => {
      const frame = encode(0, V6B_FRAME_PING, new Uint8Array(0));
      expect(frame[0]).toBe(0x03);
    });

    // Test 4: frame type
    it('writes frame type at offset 1', () => {
      const frame = encode(0, V6B_FRAME_V6A_MESSAGE, makePayload(1));
      expect(frame[1]).toBe(V6B_FRAME_V6A_MESSAGE);
    });

    // Test 5: UInt32 BIG_ENDIAN sequence
    it('encodes sequence as UInt32 BIG_ENDIAN at bytes 2–5', () => {
      const frame = encode(0x01020304, V6B_FRAME_PING, new Uint8Array(0));
      expect(frame[2]).toBe(0x01);
      expect(frame[3]).toBe(0x02);
      expect(frame[4]).toBe(0x03);
      expect(frame[5]).toBe(0x04);
    });

    // Test 6: UInt32 BIG_ENDIAN payloadLength
    it('encodes payloadLength as UInt32 BIG_ENDIAN at bytes 6–9', () => {
      const frame = encode(0, V6B_FRAME_V6A_MESSAGE, makePayload(256));
      expect(frame[6]).toBe(0x00);
      expect(frame[7]).toBe(0x00);
      expect(frame[8]).toBe(0x01);
      expect(frame[9]).toBe(0x00);
    });

    // Test 7: exact payload length
    it('payload length matches exactly', () => {
      const payload = makePayload(42);
      const frame = encode(0, V6B_FRAME_V6A_MESSAGE, payload);
      const decoded = decode(frame);
      expect(decoded.payloadLength).toBe(42);
      expect(decoded.payload.length).toBe(42);
    });

    // Test 8: empty PING
    it('encodes/decodes empty PING', () => {
      const frame = encode(100, V6B_FRAME_PING, new Uint8Array(0));
      expect(frame.length).toBe(V6B_HEADER_SIZE);
      const decoded = decode(frame);
      expect(decoded.frameType).toBe(V6B_FRAME_PING);
      expect(decoded.sequence).toBe(100);
      expect(decoded.payloadLength).toBe(0);
      expect(decoded.payload.length).toBe(0);
    });

    // Test 9: ACK-sized payload (8 bytes)
    it('encodes/decodes ACK frame with 8-byte payload', () => {
      const ackPayload = makePayload(8);
      const frame = encode(1, V6B_FRAME_ACK, ackPayload);
      const decoded = decode(frame);
      expect(decoded.frameType).toBe(V6B_FRAME_ACK);
      expect(decoded.payloadLength).toBe(8);
      expect(decoded.payload.length).toBe(8);
    });

    // Test 10: NACK-sized payload (9 bytes)
    it('encodes/decodes NACK frame with 9-byte payload', () => {
      const nackPayload = makePayload(9);
      const frame = encode(2, V6B_FRAME_NACK, nackPayload);
      const decoded = decode(frame);
      expect(decoded.frameType).toBe(V6B_FRAME_NACK);
      expect(decoded.payloadLength).toBe(9);
      expect(decoded.payload.length).toBe(9);
    });

    // Test 11: maximum 499-byte payload
    it('encodes/decodes maximum 499-byte payload', () => {
      const payload = makePayload(499);
      const frame = encode(0, V6B_FRAME_V6A_MESSAGE, payload);
      expect(frame.length).toBe(V6B_MAX_FRAME_SIZE);
      const decoded = decode(frame);
      expect(decoded.payloadLength).toBe(499);
      expect(decoded.payload.length).toBe(499);
    });

    // Test 12: 500-byte payload rejected
    it('rejects 500-byte payload on encode', () => {
      const payload = makePayload(500);
      expect(() => encode(0, V6B_FRAME_V6A_MESSAGE, payload)).toThrow(V6BFrameError);
      expect(() => encode(0, V6B_FRAME_V6A_MESSAGE, payload)).toThrow(/Payload too large/);
    });

    // Test 13: 509-byte total frame
    it('maximum valid frame is 509 bytes', () => {
      const payload = makePayload(499); // 10 + 499 = 509
      const frame = encode(0, V6B_FRAME_V6A_MESSAGE, payload);
      expect(frame.length).toBe(509);
      const decoded = decode(frame);
      expect(decoded.payload.length).toBe(499);
    });

    // Test 14: 510-byte total frame rejected
    it('rejects frame exceeding 509 bytes on encode', () => {
      // 500-byte payload → 510-byte frame → exceeds 509
      const payload = makePayload(500);
      expect(() => encode(0, V6B_FRAME_V6A_MESSAGE, payload)).toThrow(V6BFrameError);
    });
  });

  describe('error handling', () => {
    // Test 15: malformed frame
    it('rejects frame with wrong version', () => {
      const frame = encode(0, V6B_FRAME_PING, new Uint8Array(0));
      frame[0] = 0xFF; // corrupt version
      expect(() => decode(frame)).toThrow(V6BFrameError);
      expect(() => decode(frame)).toThrow(/Unsupported version/);
    });

    // Test 16: truncated frame
    it('rejects frame shorter than header', () => {
      const short = new Uint8Array(5);
      expect(() => decode(short)).toThrow(V6BFrameError);
      expect(() => decode(short)).toThrow(/Frame too short/);
    });

    // Test 17: bad payload length
    it('rejects frame with payload length exceeding max', () => {
      const frame = encode(0, V6B_FRAME_V6A_MESSAGE, makePayload(10));
      // Corrupt payload length to claim 500 bytes
      frame[6] = 0x00;
      frame[7] = 0x00;
      frame[8] = 0x01;
      frame[9] = 0xf4; // 500
      expect(() => decode(frame)).toThrow(V6BFrameError);
      expect(() => decode(frame)).toThrow(/Payload length exceeds maximum/);
    });

    // Test 18: bad version
    it('rejects unknown version byte', () => {
      const frame = encode(0, V6B_FRAME_PING, new Uint8Array(0));
      frame[0] = 0x01; // wrong version
      expect(() => decode(frame)).toThrow(V6BFrameError);
    });

    // Test 19: unknown frame type
    it('rejects unknown frame type on decode', () => {
      const frame = encode(0, V6B_FRAME_PING, new Uint8Array(0));
      frame[1] = 0xFF; // corrupt frame type
      expect(() => decode(frame)).toThrow(V6BFrameError);
      expect(() => decode(frame)).toThrow(/Unknown frame type/);
    });

    // Test 20: deterministic encoding
    it('produces identical bytes for same inputs', () => {
      const payload = makePayload(10);
      const a = encode(42, V6B_FRAME_V6A_MESSAGE, payload);
      const b = encode(42, V6B_FRAME_V6A_MESSAGE, payload);
      expect(a.length).toBe(b.length);
      for (let i = 0; i < a.length; i++) {
        expect(a[i]).toBe(b[i]);
      }
    });

    it('rejects invalid sequence on encode', () => {
      expect(() => encode(-1, V6B_FRAME_PING, new Uint8Array(0))).toThrow(V6BFrameError);
      expect(() => encode(0x100000000, V6B_FRAME_PING, new Uint8Array(0))).toThrow(V6BFrameError);
    });

    it('rejects unknown frame type on encode', () => {
      expect(() => encode(0, 0xFF, new Uint8Array(0))).toThrow(V6BFrameError);
      expect(() => encode(0, 0xFF, new Uint8Array(0))).toThrow(/Unknown frame type/);
    });
  });

  describe('safeDecode', () => {
    it('returns decoded frame for valid input', () => {
      const frame = encode(0, V6B_FRAME_PING, new Uint8Array(0));
      expect(safeDecode(frame)).not.toBeNull();
    });

    it('returns null for invalid input', () => {
      expect(safeDecode(new Uint8Array(5))).toBeNull();
      expect(safeDecode(new Uint8Array(0))).toBeNull();
    });
  });

  describe('validateFrame', () => {
    it('returns valid: true for correct frame', () => {
      const frame = encode(0, V6B_FRAME_PING, new Uint8Array(0));
      expect(validateFrame(frame)).toEqual({ valid: true });
    });

    it('returns valid: false for short frame', () => {
      const result = validateFrame(new Uint8Array(3));
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('FRAME_TOO_SHORT');
      }
    });

    it('returns valid: false for wrong version', () => {
      const frame = encode(0, V6B_FRAME_PING, new Uint8Array(0));
      frame[0] = 0xFF;
      const result = validateFrame(frame);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('UNSUPPORTED_VERSION');
      }
    });
  });
});

// ══════════════════════════════════════════════════════════════════
// 21–24. SEQUENCE MANAGER TESTS
// ══════════════════════════════════════════════════════════════════

describe('SequenceManager', () => {
  // Test 21: starts at 0
  it('starts at 0 by default', () => {
    const mgr = new SequenceManager();
    expect(mgr.nextSequence()).toBe(0);
  });

  // Test 22: increments
  it('increments with each call', () => {
    const mgr = new SequenceManager();
    expect(mgr.nextSequence()).toBe(0);
    expect(mgr.nextSequence()).toBe(1);
    expect(mgr.nextSequence()).toBe(2);
  });

  // Test 23: multiple sequences
  it('produces a sequence of consecutive values', () => {
    const mgr = new SequenceManager(10);
    const seqs: number[] = [];
    for (let i = 0; i < 5; i++) {
      seqs.push(mgr.nextSequence());
    }
    expect(seqs).toEqual([10, 11, 12, 13, 14]);
  });

  // Test 24: wraps at UInt32 max
  it('wraps from 0xFFFFFFFF to 0x00000000', () => {
    const mgr = new SequenceManager(0xFFFFFFFF);
    expect(mgr.nextSequence()).toBe(0xFFFFFFFF);
    expect(mgr.nextSequence()).toBe(0x00000000);
    expect(mgr.nextSequence()).toBe(0x00000001);
  });

  it('supports custom initial sequence', () => {
    const mgr = new SequenceManager(42);
    expect(mgr.nextSequence()).toBe(42);
    expect(mgr.peek()).toBe(43);
  });

  it('peek does not increment', () => {
    const mgr = new SequenceManager(5);
    expect(mgr.peek()).toBe(5);
    expect(mgr.peek()).toBe(5);
    expect(mgr.nextSequence()).toBe(5);
    expect(mgr.peek()).toBe(6);
  });
});

// ══════════════════════════════════════════════════════════════════
// 25–32. SEQUENCE VALIDATOR TESTS
// ══════════════════════════════════════════════════════════════════

describe('SequenceValidator', () => {
  // Test 25: first sequence
  it('accepts the first sequence from a source', () => {
    const validator = new SequenceValidator();
    const result = validator.validate('device_A', 0);
    expect(result.valid).toBe(true);
    expect(result.gap).toBeUndefined();
    expect(result.duplicate).toBeUndefined();
  });

  // Test 26: expected sequence
  it('accepts the expected next sequence', () => {
    const validator = new SequenceValidator();
    validator.validate('device_A', 0);
    validator.validate('device_A', 1);
    validator.validate('device_A', 2);
    const result = validator.validate('device_A', 3);
    expect(result.valid).toBe(true);
    expect(result.gap).toBeUndefined();
  });

  // Test 27: gap detection
  it('detects a gap when sequence jumps ahead', () => {
    const validator = new SequenceValidator();
    validator.validate('device_A', 0);
    validator.validate('device_A', 1);
    const result = validator.validate('device_A', 5);
    expect(result.valid).toBe(true);
    expect(result.gap).toBe(true);
  });

  // Test 28: duplicate detection
  it('detects duplicate when same sequence is received twice', () => {
    const validator = new SequenceValidator();
    validator.validate('device_A', 3);
    const result = validator.validate('device_A', 3);
    expect(result.valid).toBe(false);
    expect(result.duplicate).toBe(true);
  });

  // Test 29: older sequence detection
  it('detects older sequence as duplicate', () => {
    const validator = new SequenceValidator();
    validator.validate('device_A', 5);
    validator.validate('device_A', 6);
    const result = validator.validate('device_A', 3);
    expect(result.valid).toBe(false);
    expect(result.duplicate).toBe(true);
  });

  // Test 30: UInt32 wraparound
  it('handles UInt32 wraparound correctly', () => {
    const validator = new SequenceValidator();
    validator.validate('device_A', 0xFFFFFFFE);
    // Expected next = 0xFFFFFFFF
    const result1 = validator.validate('device_A', 0xFFFFFFFF);
    expect(result1.valid).toBe(true);
    // Expected next = 0x00000000
    const result2 = validator.validate('device_A', 0x00000000);
    expect(result2.valid).toBe(true);
    // Expected next = 0x00000001
    const result3 = validator.validate('device_A', 0x00000001);
    expect(result3.valid).toBe(true);
  });

  it('detects duplicate after UInt32 wraparound', () => {
    const validator = new SequenceValidator();
    validator.validate('device_A', 0xFFFFFFFF);
    validator.validate('device_A', 0x00000000);
    // Sending 0xFFFFFFFF again should be duplicate
    const result = validator.validate('device_A', 0xFFFFFFFF);
    expect(result.valid).toBe(false);
    expect(result.duplicate).toBe(true);
  });

  // Test 31: independent source devices
  it('tracks sequences independently per source', () => {
    const validator = new SequenceValidator();
    validator.validate('device_A', 0);
    validator.validate('device_A', 1);
    validator.validate('device_B', 10);
    // device_A gets 2 (expected)
    const resultA = validator.validate('device_A', 2);
    expect(resultA.valid).toBe(true);
    // device_B gets 11 (expected)
    const resultB = validator.validate('device_B', 11);
    expect(resultB.valid).toBe(true);
    // device_A gets 10 (gap from device_B's sequence but valid for A's perspective)
    const resultC = validator.validate('device_A', 10);
    expect(resultC.valid).toBe(true);
    expect(resultC.gap).toBe(true);
  });

  // Test 32: reset(sourceId)
  it('reset clears state for a source', () => {
    const validator = new SequenceValidator();
    validator.validate('device_A', 5);
    validator.reset('device_A');
    // After reset, next sequence should be accepted as first
    const result = validator.validate('device_A', 100);
    expect(result.valid).toBe(true);
    expect(result.gap).toBeUndefined();
  });

  it('reset does not affect other sources', () => {
    const validator = new SequenceValidator();
    validator.validate('device_A', 0);
    validator.validate('device_B', 0);
    validator.reset('device_A');
    // device_B still has state
    const result = validator.validate('device_B', 0);
    expect(result.valid).toBe(false);
    expect(result.duplicate).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
// 33–36. INTEGRATION TESTS
// ══════════════════════════════════════════════════════════════════

describe('Integration', () => {
  // Test 33: V6B wrapping V6A → decode V6B → decode V6A
  it('V6B wrapping V6A decodes to SemanticMessage', () => {
    const msg = makeV6aMessage({ text: 'Integration test' });
    const v6aPacket = v6aEncode(msg);

    // Wrap in V6B
    const frame = encode(1, V6B_FRAME_V6A_MESSAGE, v6aPacket);
    const decoded = decode(frame);

    expect(decoded.frameType).toBe(V6B_FRAME_V6A_MESSAGE);
    expect(decoded.sequence).toBe(1);

    // Decode V6A payload
    const { decode: v6aDecode } = require('../BinaryMessageCodec');
    const semanticMsg = v6aDecode(decoded.payload);
    expect(semanticMsg.text).toBe('Integration test');
    expect(semanticMsg.language).toBe('en');
  });

  // Test 34: V4 fallback still works
  it('V4 JSON fallback is unaffected by V6B', () => {
    const v4Json = JSON.stringify({
      version: 1,
      messageId: 'msg_v4_fallback_00',
      text: 'V4 still works',
      language: 'en',
      emotion: 'neutral',
      emotionConfidence: 0.0,
      voiceProfile: 'default',
    });
    const { safeDecode: v4SafeDecode } = require('../../semantic/SemanticMessageCodec');
    const result = v4SafeDecode(v4Json);
    expect(result).not.toBeNull();
    expect(result!.text).toBe('V4 still works');
  });

  // Test 35: V6A direct fallback still works
  it('V6A binary without V6B envelope is still decodable', () => {
    const msg = makeV6aMessage({ text: 'Direct V6A' });
    const v6aPacket = v6aEncode(msg);

    // V6A packet starts with 0x02 — not wrapped in V6B
    expect(v6aPacket[0]).toBe(0x02);

    // V6A decode works directly
    const { decode: v6aDecode2 } = require('../BinaryMessageCodec');
    const result = v6aDecode2(v6aPacket);
    expect(result.text).toBe('Direct V6A');
  });

  // Test 36: V6B round trip preserves SemanticMessage
  it('full round trip: SemanticMessage → V6A → V6B → decode V6B → decode V6A → SemanticMessage', () => {
    const msg = makeV6aMessage({
      text: 'Full round trip 🌍🔬💡',
      language: 'hi',
      emotion: 'happy',
      emotionConfidence: 0.85,
    });

    // Step 1: Encode to V6A
    const v6aPacket = v6aEncode(msg);

    // Step 2: Wrap in V6B with sequence number
    const mgr = new SequenceManager(42);
    const seq = mgr.nextSequence();
    const frame = encode(seq, V6B_FRAME_V6A_MESSAGE, v6aPacket);

    // Step 3: Decode V6B frame
    const decodedFrame = decode(frame);
    expect(decodedFrame.sequence).toBe(42);
    expect(decodedFrame.frameType).toBe(V6B_FRAME_V6A_MESSAGE);

    // Step 4: Decode V6A payload
    const { decode: v6aDecode3 } = require('../BinaryMessageCodec');
    const decodedMsg = v6aDecode3(decodedFrame.payload);

    // Step 5: Verify all semantic fields preserved
    expect(decodedMsg.text).toBe('Full round trip 🌍🔬💡');
    expect(decodedMsg.language).toBe('hi');
    expect(decodedMsg.emotion).toBe('happy');
    expect(decodedMsg.emotionConfidence).toBeCloseTo(0.85, 1);
    expect(decodedMsg.voiceProfile).toBe('default');
  });

  it('V6B frame detection by first byte', () => {
    // V6B frame starts with 0x03
    const frame = encode(0, V6B_FRAME_PING, new Uint8Array(0));
    expect(frame[0]).toBe(0x03);

    // V6A packet starts with 0x02
    const v6aPacket = v6aEncode(makeV6aMessage());
    expect(v6aPacket[0]).toBe(0x02);

    // V4 JSON starts with 0x7B
    const v4Json = JSON.stringify({ version: 1, text: 'hi' });
    expect(v4Json.charCodeAt(0)).toBe(0x7b);
  });
});
