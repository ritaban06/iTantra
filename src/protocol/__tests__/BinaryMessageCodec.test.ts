/**
 * V6A Binary Semantic Protocol — Tests
 *
 * Comprehensive tests for BinaryMessageCodec.
 */

import { SemanticMessage } from '../../semantic/SemanticMessageTypes';
import {
  encode,
  encodeUnrestricted,
  decode,
  safeDecode,
  decodeWithFallback,
  validatePacket,
  hashMessageId,
  fnv1a64,
  getEncodedByteLength,
  BinaryCodecError,
} from '../BinaryMessageCodec';
import {
  PROTOCOL_VERSION,
  MSG_TYPE_TEXT,
  HEADER_SIZE,
  MAX_BLE_PAYLOAD,
} from '../BinaryMessageTypes';

// ── Test Helpers ──────────────────────────────────────────────────

function makeMessage(overrides: Partial<SemanticMessage> = {}): SemanticMessage {
  return {
    version: 1,
    messageId: 'msg_test_abc123_00',
    text: 'Hello judges',
    language: 'en',
    emotion: 'neutral',
    emotionConfidence: 0.0,
    voiceProfile: 'default',
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════
// 1. ENCODE / DECODE ROUND TRIP
// ══════════════════════════════════════════════════════════════════

describe('V6A BinaryMessageCodec', () => {
  describe('encode/decode round trip', () => {
    it('preserves all semantic fields through round trip', () => {
      const msg = makeMessage({
        text: 'Hello judges',
        language: 'en',
        emotion: 'happy',
        emotionConfidence: 0.85,
        voiceProfile: 'default',
      });

      const packet = encode(msg);
      const decoded = decode(packet);

      expect(decoded.version).toBe(PROTOCOL_VERSION);
      expect(decoded.text).toBe('Hello judges');
      expect(decoded.language).toBe('en');
      expect(decoded.emotion).toBe('happy');
      expect(decoded.voiceProfile).toBe('default');
      // Confidence quantized to UInt8: 0.85 * 255 = 216.75 → 217 / 255 ≈ 0.85098
      expect(decoded.emotionConfidence).toBeCloseTo(0.85, 1);
    });

    it('is deterministic (same input → same bytes)', () => {
      const msg = makeMessage();
      const a = encode(msg);
      const b = encode(msg);
      expect(a.length).toBe(b.length);
      for (let i = 0; i < a.length; i++) {
        expect(a[i]).toBe(b[i]);
      }
    });

    it('preserves the messageId as a compact hash string', () => {
      const msg = makeMessage({ messageId: 'msg_abc_123_00' });
      const packet = encode(msg);
      const decoded = decode(packet);

      // The decoded messageId is the compact hash representation
      expect(decoded.messageId).toMatch(/^0x[0-9a-f]{16}$/);
      // It is NOT the original string
      expect(decoded.messageId).not.toBe('msg_abc_123_00');
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 2. ENGLISH TEXT
  // ════════════════════════════════════════════════════════════════

  describe('English text', () => {
    it('encodes/decodes "Hello judges" correctly', () => {
      const msg = makeMessage({ text: 'Hello judges', language: 'en' });
      const packet = encode(msg);
      const decoded = decode(packet);
      expect(decoded.text).toBe('Hello judges');
      expect(decoded.language).toBe('en');
    });

    it('calculates correct packet size for "Hello judges"', () => {
      const msg = makeMessage({ text: 'Hello judges' });
      const packet = encode(msg);
      // 18 header + 12 ASCII bytes = 30
      expect(packet.length).toBe(30);
      expect(getEncodedByteLength(msg)).toBe(30);
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 3. HINDI TEXT
  // ════════════════════════════════════════════════════════════════

  describe('Hindi text', () => {
    it('encodes/decodes Hindi correctly', () => {
      const msg = makeMessage({ text: '\u0906\u092A \u0915\u0948\u0938\u0947 \u0939\u0948\u0902?', language: 'hi' });
      const packet = encode(msg);
      const decoded = decode(packet);
      expect(decoded.text).toBe('\u0906\u092A \u0915\u0948\u0938\u0947 \u0939\u0948\u0902?');
      expect(decoded.language).toBe('hi');
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 4. BENGALI TEXT
  // ════════════════════════════════════════════════════════════════

  describe('Bengali text', () => {
    it('encodes/decodes Bengali correctly', () => {
      const msg = makeMessage({ text: '\u0986\u09AA\u09A8\u09BF \u0995\u09C7\u09AE\u09A8 \u0986\u099B\u09C7\u09A8?', language: 'bn' });
      const packet = encode(msg);
      const decoded = decode(packet);
      expect(decoded.text).toBe('\u0986\u09AA\u09A8\u09BF \u0995\u09C7\u09AE\u09A8 \u0986\u099B\u09C7\u09A8?');
      expect(decoded.language).toBe('bn');
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 5. EMOJI TEXT
  // ════════════════════════════════════════════════════════════════

  describe('Emoji text', () => {
    it('encodes/decodes emoji correctly', () => {
      const msg = makeMessage({ text: 'Hello \uD83D\uDC4B\uD83C\uDF0D\uD83D\uDD2C' });
      const packet = encode(msg);
      const decoded = decode(packet);
      expect(decoded.text).toBe('Hello \uD83D\uDC4B\uD83C\uDF0D\uD83D\uDD2C');
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 6. EMOTIONS
  // ════════════════════════════════════════════════════════════════

  describe('emotion encoding', () => {
    it('neutral (0x00)', () => {
      const msg = makeMessage({ emotion: 'neutral' });
      const packet = encode(msg);
      expect(packet[3]).toBe(0x00);
      const decoded = decode(packet);
      expect(decoded.emotion).toBe('neutral');
    });

    it('happy (0x01)', () => {
      const msg = makeMessage({ emotion: 'happy' });
      const packet = encode(msg);
      expect(packet[3]).toBe(0x01);
      const decoded = decode(packet);
      expect(decoded.emotion).toBe('happy');
    });

    it('sad (0x02)', () => {
      const msg = makeMessage({ emotion: 'sad' });
      const packet = encode(msg);
      expect(packet[3]).toBe(0x02);
      const decoded = decode(packet);
      expect(decoded.emotion).toBe('sad');
    });

    it('angry (0x03)', () => {
      const msg = makeMessage({ emotion: 'angry' });
      const packet = encode(msg);
      expect(packet[3]).toBe(0x03);
      const decoded = decode(packet);
      expect(decoded.emotion).toBe('angry');
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 7. CONFIDENCE ENCODING
  // ════════════════════════════════════════════════════════════════

  describe('confidence encoding', () => {
    it('0.0 → byte 0', () => {
      const msg = makeMessage({ emotionConfidence: 0.0 });
      const packet = encode(msg);
      expect(packet[4]).toBe(0);
      const decoded = decode(packet);
      expect(decoded.emotionConfidence).toBe(0);
    });

    it('1.0 → byte 255', () => {
      const msg = makeMessage({ emotionConfidence: 1.0 });
      const packet = encode(msg);
      expect(packet[4]).toBe(255);
      const decoded = decode(packet);
      expect(decoded.emotionConfidence).toBe(1.0);
    });

    it('0.5 → byte 128, decode ≈ 0.502', () => {
      const msg = makeMessage({ emotionConfidence: 0.5 });
      const packet = encode(msg);
      expect(packet[4]).toBe(128);
      const decoded = decode(packet);
      expect(decoded.emotionConfidence).toBeCloseTo(128 / 255, 4);
    });

    it('clamps values outside [0, 1]', () => {
      const msgHigh = makeMessage({ emotionConfidence: 1.5 });
      const packetHigh = encode(msgHigh);
      expect(packetHigh[4]).toBe(255);

      const msgLow = makeMessage({ emotionConfidence: -0.3 });
      const packetLow = encode(msgLow);
      expect(packetLow[4]).toBe(0);
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 8. LANGUAGE REGISTRY
  // ════════════════════════════════════════════════════════════════

  describe('language registry', () => {
    it('encodes English as 0x01', () => {
      const msg = makeMessage({ language: 'en' });
      const packet = encode(msg);
      expect(packet[2]).toBe(0x01);
      expect(decode(packet).language).toBe('en');
    });

    it('encodes Hindi as 0x02', () => {
      const msg = makeMessage({ language: 'hi' });
      const packet = encode(msg);
      expect(packet[2]).toBe(0x02);
      expect(decode(packet).language).toBe('hi');
    });

    it('encodes Bengali as 0x03', () => {
      const msg = makeMessage({ language: 'bn' });
      const packet = encode(msg);
      expect(packet[2]).toBe(0x03);
      expect(decode(packet).language).toBe('bn');
    });

    it('encodes unknown language as 0x00', () => {
      // "xx" is not in the registry, encode defaults to 0x00
      const msg = makeMessage({ language: 'xx' as any });
      const packet = encode(msg);
      expect(packet[2]).toBe(0x00);
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 9. MESSAGE ID HASHING
  // ════════════════════════════════════════════════════════════════

  describe('message ID hashing', () => {
    it('produces a deterministic compact hash', () => {
      const id = 'msg_abc_123_00';
      const h1 = hashMessageId(id);
      const h2 = hashMessageId(id);
      expect(h1).toBe(h2);
    });

    it('different strings produce different hashes', () => {
      const h1 = hashMessageId('msg_abc_00');
      const h2 = hashMessageId('msg_xyz_00');
      expect(h1).not.toBe(h2);
    });

    it('fnv1a64 is deterministic for known input', () => {
      const bytes = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]); // "hello"
      const hash = fnv1a64(bytes);
      // Verify it's a bigint and non-zero
      expect(typeof hash).toBe('bigint');
      expect(hash > BigInt(0)).toBe(true);
    });

    it('compact hash is written as UInt64 BIG_ENDIAN', () => {
      const msg = makeMessage();
      const packet = encode(msg);
      const compactId = hashMessageId(msg.messageId);

      // Verify bytes 6-13 match the compact hash in BIG_ENDIAN
      for (let i = 0; i < 8; i++) {
        const expectedByte = Number((compactId >> BigInt(56 - i * 8)) & BigInt(0xff));
        expect(packet[6 + i]).toBe(expectedByte);
      }
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 10. MALFORMED / TRUNCATED PACKETS
  // ════════════════════════════════════════════════════════════════

  describe('malformed packets', () => {
    it('rejects packet shorter than 18 bytes', () => {
      const short = new Uint8Array(10);
      expect(() => decode(short)).toThrow(BinaryCodecError);
      expect(safeDecode(short)).toBeNull();
    });

    it('rejects wrong version byte', () => {
      const msg = makeMessage();
      const packet = encode(msg);
      packet[0] = 0xFF;
      expect(() => decode(packet)).toThrow(BinaryCodecError);
    });

    it('rejects invalid message type', () => {
      const msg = makeMessage();
      const packet = encode(msg);
      packet[1] = 0xFF;
      expect(() => decode(packet)).toThrow(BinaryCodecError);
    });

    it('rejects invalid language code', () => {
      const msg = makeMessage();
      const packet = encode(msg);
      packet[2] = 0xFF;
      expect(() => decode(packet)).toThrow(BinaryCodecError);
    });

    it('rejects invalid emotion code', () => {
      const msg = makeMessage();
      const packet = encode(msg);
      packet[3] = 0xFF;
      expect(() => decode(packet)).toThrow(BinaryCodecError);
    });

    it('rejects invalid voice profile code', () => {
      const msg = makeMessage();
      const packet = encode(msg);
      packet[5] = 0xFF;
      expect(() => decode(packet)).toThrow(BinaryCodecError);
    });

    it('rejects truncated text (textLength mismatch)', () => {
      const msg = makeMessage({ text: 'Hello' });
      const packet = encode(msg);
      // Corrupt textLength to claim more bytes than present
      packet[14] = 0x00;
      packet[15] = 0x00;
      packet[16] = 0x00;
      packet[17] = 0x64; // 100 bytes textLength
      expect(() => decode(packet)).toThrow(BinaryCodecError);
    });

    it('rejects empty text', () => {
      const msg = makeMessage({ text: '' });
      expect(() => encode(msg)).toThrow(BinaryCodecError);
    });

    it('rejects whitespace-only text', () => {
      const msg = makeMessage({ text: '   ' });
      expect(() => encode(msg)).toThrow(BinaryCodecError);
    });

    it('returns null for safeDecode on malformed packet', () => {
      expect(safeDecode(new Uint8Array(5))).toBeNull();
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 11. BIG_ENDIAN INTEGER ENCODING
  // ════════════════════════════════════════════════════════════════

  describe('BIG_ENDIAN encoding', () => {
    it('textLength is BIG_ENDIAN UInt32', () => {
      const msg = makeMessage({ text: 'Hello' }); // 5 UTF-8 bytes
      const packet = encode(msg);
      // textLength = 5 = 0x00000005
      expect(packet[14]).toBe(0x00);
      expect(packet[15]).toBe(0x00);
      expect(packet[16]).toBe(0x00);
      expect(packet[17]).toBe(0x05);
    });

    it('messageId is BIG_ENDIAN UInt64', () => {
      const msg = makeMessage();
      const packet = encode(msg);
      const compactId = hashMessageId(msg.messageId);

      // Check first byte is non-zero (high byte of hash)
      const highByte = Number((compactId >> BigInt(56)) & BigInt(0xff));
      expect(packet[6]).toBe(highByte);
    });

    it('version byte is at offset 0', () => {
      const msg = makeMessage();
      const packet = encode(msg);
      expect(packet[0]).toBe(PROTOCOL_VERSION);
    });

    it('messageType byte is at offset 1', () => {
      const msg = makeMessage();
      const packet = encode(msg);
      expect(packet[1]).toBe(MSG_TYPE_TEXT);
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 12. PACKET SIZE CALCULATIONS
  // ════════════════════════════════════════════════════════════════

  describe('packet size', () => {
    it('"Hello judges" = 30 bytes', () => {
      const msg = makeMessage({ text: 'Hello judges' });
      expect(getEncodedByteLength(msg)).toBe(30);
      expect(encode(msg).length).toBe(30);
    });

    it('Hindi text size matches UTF-8 byte count + header', () => {
      const text = '\u0906\u092A \u0915\u0948\u0938\u0947 \u0939\u0948\u0902?';
      const msg = makeMessage({ text });
      const len = getEncodedByteLength(msg);
      expect(len).toBeGreaterThan(HEADER_SIZE);
      expect(encode(msg).length).toBe(len);
    });

    it('long English sentence is within BLE limit', () => {
      const text = 'I would like to discuss the upcoming project timeline with you and review the current status.';
      const msg = makeMessage({ text });
      const len = getEncodedByteLength(msg);
      expect(len).toBeLessThanOrEqual(MAX_BLE_PAYLOAD);
      expect(encode(msg).length).toBe(len);
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 13. BLE PAYLOAD OVERFLOW
  // ════════════════════════════════════════════════════════════════

  describe('BLE payload overflow', () => {
    it('rejects text that would exceed BLE payload limit', () => {
      // Create text longer than MAX_BLE_PAYLOAD - HEADER_SIZE
      const longText = 'x'.repeat(MAX_BLE_PAYLOAD);
      const msg = makeMessage({ text: longText });
      expect(() => encode(msg)).toThrow(BinaryCodecError);
      expect(() => encode(msg)).toThrow(/exceeds BLE payload limit/);
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 14. V4 JSON FALLBACK
  // ════════════════════════════════════════════════════════════════

  describe('V4 JSON fallback', () => {
    it('decodes V6A binary via decodeWithFallback', () => {
      const msg = makeMessage();
      const packet = encode(msg);
      const decoded = decodeWithFallback(packet);
      expect(decoded).not.toBeNull();
      expect(decoded!.text).toBe('Hello judges');
    });

    it('decodes V4 JSON string via decodeWithFallback', () => {
      const v4Json = JSON.stringify({
        version: 1,
        messageId: 'msg_v4_test_00',
        text: 'Hello from V4',
        language: 'en',
        emotion: 'neutral',
        emotionConfidence: 0.0,
        voiceProfile: 'default',
      });
      const decoded = decodeWithFallback(v4Json);
      expect(decoded).not.toBeNull();
      expect(decoded!.text).toBe('Hello from V4');
      expect(decoded!.messageId).toBe('msg_v4_test_00');
    });

    it('decodes V4 JSON Uint8Array via decodeWithFallback', () => {
      const v4Json = JSON.stringify({
        version: 1,
        messageId: 'msg_v4_bytes_00',
        text: 'V4 bytes',
        language: 'en',
        emotion: 'happy',
        emotionConfidence: 0.7,
        voiceProfile: 'default',
      });
      // Manually encode string to UTF-8 bytes (no TextEncoder)
      const bytes: number[] = [];
      for (let i = 0; i < v4Json.length; i++) {
        const code = v4Json.charCodeAt(i);
        if (code < 0x80) bytes.push(code);
        else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        else bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      }
      const decoded = decodeWithFallback(new Uint8Array(bytes));
      expect(decoded).not.toBeNull();
      expect(decoded!.text).toBe('V4 bytes');
      expect(decoded!.emotion).toBe('happy');
    });

    it('returns null for unknown first byte', () => {
      const unknown = new Uint8Array([0xAA, 0xBB, 0xCC]);
      expect(decodeWithFallback(unknown)).toBeNull();
    });

    it('returns null for empty input', () => {
      expect(decodeWithFallback(new Uint8Array(0))).toBeNull();
      expect(decodeWithFallback('')).toBeNull();
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 15. VALIDATE PACKET
  // ════════════════════════════════════════════════════════════════

  describe('validatePacket', () => {
    it('returns valid: true for correct packet', () => {
      const msg = makeMessage();
      const packet = encode(msg);
      expect(validatePacket(packet)).toEqual({ valid: true });
    });

    it('returns valid: false with error for short packet', () => {
      const result = validatePacket(new Uint8Array(5));
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('PACKET_TOO_SHORT');
      }
    });

    it('returns valid: false for wrong version', () => {
      const msg = makeMessage();
      const packet = encode(msg);
      packet[0] = 0xFF;
      const result = validatePacket(packet);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe('UNSUPPORTED_VERSION');
      }
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 16. ALL SEMANTIC FIELDS PRESERVED
  // ════════════════════════════════════════════════════════════════

  describe('all semantic fields preserved', () => {
    it('preserves version', () => {
      const msg = makeMessage();
      const decoded = decode(encode(msg));
      expect(decoded.version).toBe(PROTOCOL_VERSION);
    });

    it('preserves text exactly', () => {
      const msg = makeMessage({ text: 'Special chars: \u00E0\u00E1\u00E2\u00E3\u00E4\u00E5 \u00F1 \u00FC \uD83D\uDCA1' });
      const decoded = decode(encode(msg));
      expect(decoded.text).toBe('Special chars: \u00E0\u00E1\u00E2\u00E3\u00E4\u00E5 \u00F1 \u00FC \uD83D\uDCA1');
    });

    it('preserves language', () => {
      const msg = makeMessage({ language: 'hi' });
      const decoded = decode(encode(msg));
      expect(decoded.language).toBe('hi');
    });

    it('preserves emotion', () => {
      const msg = makeMessage({ emotion: 'sad' });
      const decoded = decode(encode(msg));
      expect(decoded.emotion).toBe('sad');
    });

    it('preserves emotionConfidence within UInt8 quantization', () => {
      const msg = makeMessage({ emotionConfidence: 0.73 });
      const decoded = decode(encode(msg));
      // 0.73 * 255 = 186.15 → 186 → 186/255 ≈ 0.72941
      expect(decoded.emotionConfidence).toBeCloseTo(186 / 255, 4);
    });

    it('preserves voiceProfile', () => {
      const msg = makeMessage({ voiceProfile: 'default' });
      const decoded = decode(encode(msg));
      expect(decoded.voiceProfile).toBe('default');
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 17. LONG TEXT
  // ════════════════════════════════════════════════════════════════

  describe('long text', () => {
    it('handles 491-byte text (maximum)', () => {
      const text = 'a'.repeat(491);
      const msg = makeMessage({ text });
      const packet = encode(msg);
      expect(packet.length).toBe(HEADER_SIZE + 491);
      const decoded = decode(packet);
      expect(decoded.text).toBe(text);
    });

    it('handles mixed-script long text', () => {
      const text = 'Hello \u0928\u092E\u0938\u094D\u0924\u0947 \u09A8\u09AE\u09B8\u09CD\u0995\u09BE\u09B0 ' + '\uD83C\uDF0D\uD83D\uDD2C\uD83D\uDCA1'.repeat(10);
      const msg = makeMessage({ text });
      const packet = encode(msg);
      const decoded = decode(packet);
      expect(decoded.text).toBe(text);
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 18. TEXT BYTE LAYOUT VERIFICATION
  // ════════════════════════════════════════════════════════════════

  describe('byte layout verification', () => {
    it('header fields are at correct offsets', () => {
      const msg = makeMessage({ text: 'X' });
      const packet = encode(msg);

      expect(packet[0]).toBe(PROTOCOL_VERSION);  // version
      expect(packet[1]).toBe(MSG_TYPE_TEXT);       // messageType
      expect(packet[2]).toBe(0x01);               // language: en
      expect(packet[3]).toBe(0x00);               // emotion: neutral
      expect(packet[4]).toBe(0);                   // confidence: 0.0
      expect(packet[5]).toBe(0x00);               // voiceProfile: default
      // bytes 6-13: messageId (hash)
      // bytes 14-17: textLength = 1
      expect(packet[14]).toBe(0x00);
      expect(packet[15]).toBe(0x00);
      expect(packet[16]).toBe(0x00);
      expect(packet[17]).toBe(0x01);
      // byte 18: text 'X' = 0x58
      expect(packet[18]).toBe(0x58);
    });

    it('total packet size is 18 + textLength', () => {
      const msg = makeMessage({ text: 'Test' });
      const packet = encode(msg);
      const textLength = (packet[14] << 24) | (packet[15] << 16) | (packet[16] << 8) | packet[17];
      expect(packet.length).toBe(HEADER_SIZE + textLength);
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 19. CONFIDENCE EDGE CASES
  // ════════════════════════════════════════════════════════════════

  describe('confidence edge cases', () => {
    it('NaN confidence defaults to 0', () => {
      const msg = makeMessage({ emotionConfidence: NaN as any });
      const packet = encode(msg);
      // NaN → 0 after Math.round(Math.min(1, Math.max(0, NaN)) * 255)
      expect(packet[4]).toBe(0);
    });

    it('very small confidence rounds to 0', () => {
      const msg = makeMessage({ emotionConfidence: 0.001 });
      const packet = encode(msg);
      expect(packet[4]).toBe(0);
    });

    it('very large confidence (just below 1) rounds to 254', () => {
      const msg = makeMessage({ emotionConfidence: 0.996 });
      const packet = encode(msg);
      // 0.996 * 255 = 253.98 → 254
      expect(packet[4]).toBe(254);
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 20. encodeUnrestricted()
  // ════════════════════════════════════════════════════════════════

  describe('encodeUnrestricted', () => {
    it('produces identical bytes to encode() for messages <=509 bytes', () => {
      const msg = makeMessage({ text: 'Hello judges' });
      const restricted = encode(msg);
      const unrestricted = encodeUnrestricted(msg);
      expect(unrestricted.length).toBe(restricted.length);
      for (let i = 0; i < restricted.length; i++) {
        expect(unrestricted[i]).toBe(restricted[i]);
      }
    });

    it('accepts a V6A packet >509 bytes', () => {
      const text = 'x'.repeat(500); // 500 + 18 = 518 > 509
      const msg = makeMessage({ text });
      const packet = encodeUnrestricted(msg);
      expect(packet.length).toBe(518);
    });

    it('the oversized packet is decodable by decode()', () => {
      const text = 'x'.repeat(500);
      const msg = makeMessage({ text });
      const packet = encodeUnrestricted(msg);
      const decoded = decode(packet);
      expect(decoded.text).toBe(text);
      expect(decoded.language).toBe('en');
    });

    it('V6A wire bytes are identical regardless of encode path', () => {
      const msg = makeMessage({ text: 'Test identical bytes', language: 'hi', emotion: 'happy' });
      const a = encode(msg);
      const b = encodeUnrestricted(msg);
      expect(a.length).toBe(b.length);
      for (let i = 0; i < a.length; i++) {
        expect(a[i]).toBe(b[i]);
      }
    });

    it('a >509-byte packet can be passed to FragmentCodec.splitV6A()', () => {
      const { splitV6A } = require('../FragmentCodec');
      const text = 'a'.repeat(982); // 982 + 18 = 1000 bytes V6A
      const msg = makeMessage({ text });
      const packet = encodeUnrestricted(msg);
      expect(packet.length).toBe(1000);

      const chunks = splitV6A(packet);
      expect(chunks.length).toBe(3); // 1000/490 = 3
      // Each chunk payload should be <= 499 (V6B max payload)
      for (const chunk of chunks) {
        expect(chunk.payload.length).toBeLessThanOrEqual(499);
      }
    });

    it('encode() still throws PAYLOAD_TOO_LARGE for oversized packets', () => {
      const text = 'x'.repeat(500); // 518 > 509
      const msg = makeMessage({ text });
      expect(() => encode(msg)).toThrow(BinaryCodecError);
      expect(() => encode(msg)).toThrow(/exceeds BLE payload limit/);
    });

    it('existing <=509-byte behavior remains unchanged', () => {
      const msg = makeMessage({ text: 'Hello judges' });
      const packet = encode(msg);
      expect(packet.length).toBe(30);
      expect(packet[0]).toBe(PROTOCOL_VERSION);
      expect(decode(packet).text).toBe('Hello judges');
    });

    it('multilingual Unicode text works with encodeUnrestricted', () => {
      const text = '\u0906\u092A \u0915\u0948\u0938\u0947 \u0939\u0948\u0902 \uD83C\uDF0D';
      const msg = makeMessage({ text, language: 'hi' });
      const packet = encodeUnrestricted(msg);
      const decoded = decode(packet);
      expect(decoded.text).toBe(text);
      expect(decoded.language).toBe('hi');
    });
  });
});
