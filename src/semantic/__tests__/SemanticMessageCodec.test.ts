import {
  encode,
  decode,
  validate,
  safeDecode,
  getEncodedByteLength,
  SemanticCodecError,
} from '../SemanticMessageCodec';
import {
  createSemanticMessage,
  generateMessageId,
  SemanticMessage as SMType,
  SUPPORTED_VERSION,
} from '../SemanticMessageTypes';

// ── Helper ────────────────────────────────────────────────────────

function validMessage(overrides: Partial<SMType> = {}): SMType {
  const base = createSemanticMessage('Hello judges', {
    language: 'en',
    emotion: 'neutral',
    emotionConfidence: 0.0,
    voiceProfile: 'default',
  });
  return { ...base, ...overrides };
}

// ── Encode Tests ──────────────────────────────────────────────────

describe('encode', () => {
  it('encodes a valid message to a JSON string', () => {
    const msg = validMessage();
    const json = encode(msg);
    expect(typeof json).toBe('string');
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe(SUPPORTED_VERSION);
    expect(parsed.text).toBe('Hello judges');
  });

  it('throws SemanticCodecError for empty text', () => {
    const msg = validMessage({ text: '' });
    expect(() => encode(msg)).toThrow(SemanticCodecError);
  });

  it('throws SemanticCodecError for unsupported version', () => {
    const msg = validMessage({ version: 99 });
    expect(() => encode(msg)).toThrow(SemanticCodecError);
  });
});

// ── Decode Tests ──────────────────────────────────────────────────

describe('decode', () => {
  it('decodes a valid JSON string back to a SemanticMessage', () => {
    const msg = validMessage();
    const json = encode(msg);
    const decoded = decode(json);
    expect(decoded.version).toBe(msg.version);
    expect(decoded.text).toBe(msg.text);
    expect(decoded.language).toBe(msg.language);
    expect(decoded.emotion).toBe(msg.emotion);
    expect(decoded.emotionConfidence).toBe(msg.emotionConfidence);
    expect(decoded.voiceProfile).toBe(msg.voiceProfile);
  });

  it('throws SemanticCodecError for malformed JSON', () => {
    expect(() => decode('not json')).toThrow(SemanticCodecError);
    expect(() => decode('{')).toThrow(SemanticCodecError);
  });

  it('throws SemanticCodecError for empty string', () => {
    expect(() => decode('')).toThrow(SemanticCodecError);
  });

  it('throws SemanticCodecError for JSON array instead of object', () => {
    expect(() => decode('[1,2,3]')).toThrow(SemanticCodecError);
  });

  it('throws SemanticCodecError for missing required fields', () => {
    const incomplete = JSON.stringify({ version: 1 });
    expect(() => decode(incomplete)).toThrow(SemanticCodecError);
  });

  it('throws SemanticCodecError for invalid emotion', () => {
    const msg = validMessage();
    // Bypass encode validation by directly creating a tampered JSON
    const tampered = JSON.stringify({ ...msg, emotion: 'excited' });
    expect(() => decode(tampered)).toThrow(SemanticCodecError);
  });

  it('throws SemanticCodecError for confidence out of range', () => {
    const msg = validMessage({ emotionConfidence: 1.5 });
    expect(() => encode(msg)).toThrow(SemanticCodecError);
  });

  it('throws SemanticCodecError for unsupported version in decode', () => {
    const msg = validMessage();
    const tampered = JSON.stringify({ ...msg, version: 99 });
    expect(() => decode(tampered)).toThrow(SemanticCodecError);
  });
});

// ── Round-Trip Tests ──────────────────────────────────────────────

describe('round-trip encode/decode', () => {
  it('preserves all fields through encode/decode', () => {
    const msg = validMessage();
    const json = encode(msg);
    const decoded = decode(json);
    expect(decoded).toEqual(msg);
  });

  it('preserves message ID through encode/decode', () => {
    const msg = validMessage();
    const originalId = msg.messageId;
    const decoded = decode(encode(msg));
    expect(decoded.messageId).toBe(originalId);
  });

  it('preserves Unicode text (Hindi)', () => {
    const msg = validMessage({ text: 'नमस्ते दुनिया', language: 'hi' });
    const decoded = decode(encode(msg));
    expect(decoded.text).toBe('नमस्ते दुनिया');
    expect(decoded.language).toBe('hi');
  });

  it('preserves Unicode text (emoji)', () => {
    const msg = validMessage({ text: 'Hello 🌍🎉' });
    const decoded = decode(encode(msg));
    expect(decoded.text).toBe('Hello 🌍🎉');
  });

  it('preserves all emotion values', () => {
    for (const emotion of ['neutral', 'happy', 'sad', 'angry'] as const) {
      const msg = validMessage({ emotion });
      const decoded = decode(encode(msg));
      expect(decoded.emotion).toBe(emotion);
    }
  });

  it('preserves confidence boundary values', () => {
    const msg0 = validMessage({ emotionConfidence: 0 });
    const msg1 = validMessage({ emotionConfidence: 1 });
    expect(decode(encode(msg0)).emotionConfidence).toBe(0);
    expect(decode(encode(msg1)).emotionConfidence).toBe(1);
  });
});

// ── Validate Tests ────────────────────────────────────────────────

describe('validate', () => {
  it('accepts a valid message', () => {
    expect(() => validate(validMessage())).not.toThrow();
  });

  it('rejects null/undefined', () => {
    expect(() => validate(null as any)).toThrow(SemanticCodecError);
    expect(() => validate(undefined as any)).toThrow(SemanticCodecError);
  });

  it('rejects empty text', () => {
    expect(() => validate(validMessage({ text: '' }))).toThrow(SemanticCodecError);
    expect(() => validate(validMessage({ text: '   ' }))).toThrow(SemanticCodecError);
  });

  it('rejects invalid emotion', () => {
    expect(() => validate(validMessage({ emotion: 'excited' as any }))).toThrow(SemanticCodecError);
  });

  it('rejects confidence outside [0,1]', () => {
    expect(() => validate(validMessage({ emotionConfidence: -0.1 }))).toThrow(SemanticCodecError);
    expect(() => validate(validMessage({ emotionConfidence: 1.1 }))).toThrow(SemanticCodecError);
  });

  it('rejects missing messageId', () => {
    const msg = validMessage({ messageId: '' });
    expect(() => validate(msg)).toThrow(SemanticCodecError);
  });

  it('rejects unsupported version', () => {
    expect(() => validate(validMessage({ version: 2 }))).toThrow(SemanticCodecError);
  });

  it('rejects empty language', () => {
    expect(() => validate(validMessage({ language: '' }))).toThrow(SemanticCodecError);
  });

  it('rejects empty voiceProfile', () => {
    expect(() => validate(validMessage({ voiceProfile: '' }))).toThrow(SemanticCodecError);
  });
});

// ── safeDecode Tests ──────────────────────────────────────────────

describe('safeDecode', () => {
  it('returns message for valid JSON', () => {
    const msg = validMessage();
    const result = safeDecode(encode(msg));
    expect(result).not.toBeNull();
    expect(result!.text).toBe(msg.text);
  });

  it('returns null for malformed JSON', () => {
    expect(safeDecode('not json')).toBeNull();
  });

  it('returns null for invalid message', () => {
    const invalid = JSON.stringify({ version: 1 });
    expect(safeDecode(invalid)).toBeNull();
  });
});

// ── Message ID Tests ──────────────────────────────────────────────

describe('generateMessageId', () => {
  it('generates IDs with correct prefix', () => {
    const id = generateMessageId();
    expect(id.startsWith('msg_')).toBe(true);
  });

  it('generates unique IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateMessageId());
    }
    expect(ids.size).toBe(100);
  });

  it('ID survives encode/decode unchanged', () => {
    const msg = validMessage();
    const id = msg.messageId;
    const decoded = decode(encode(msg));
    expect(decoded.messageId).toBe(id);
  });
});

// ── Byte Length Tests ─────────────────────────────────────────────

describe('getEncodedByteLength', () => {
  it('returns a positive number for a valid message', () => {
    const msg = validMessage();
    const len = getEncodedByteLength(msg);
    expect(len).toBeGreaterThan(0);
  });

  it('accounts for multi-byte UTF-8 characters', () => {
    const msgAscii = validMessage({ text: 'Hi' });
    const msgHindi = validMessage({ text: 'नमस्ते दुनिया' });
    expect(getEncodedByteLength(msgHindi)).toBeGreaterThan(getEncodedByteLength(msgAscii));
  });
});

// ── createSemanticMessage Tests ───────────────────────────────────

describe('createSemanticMessage', () => {
  it('creates a message with correct defaults', () => {
    const msg = createSemanticMessage('Test');
    expect(msg.version).toBe(SUPPORTED_VERSION);
    expect(msg.text).toBe('Test');
    expect(msg.language).toBe('en');
    expect(msg.emotion).toBe('neutral');
    expect(msg.emotionConfidence).toBe(0.0);
    expect(msg.voiceProfile).toBe('default');
    expect(msg.messageId).toBeTruthy();
  });

  it('allows overriding non-text defaults', () => {
    const msg = createSemanticMessage('Hola', {
      language: 'es',
      emotion: 'happy',
      emotionConfidence: 0.8,
    });
    expect(msg.language).toBe('es');
    expect(msg.emotion).toBe('happy');
    expect(msg.emotionConfidence).toBe(0.8);
  });

  it('generates unique IDs for each message', () => {
    const m1 = createSemanticMessage('A');
    const m2 = createSemanticMessage('B');
    expect(m1.messageId).not.toBe(m2.messageId);
  });
});
