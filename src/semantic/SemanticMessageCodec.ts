/**
 * Semantic Message Codec for iTantra BLE V4.
 *
 * Provides encode/decode/validate for SemanticMessage ↔ JSON string.
 *
 * Encoding pipeline:
 *   SemanticMessage → JSON.stringify → UTF-8 string
 *
 * The BLE layer handles Base64 encoding at the native bridge boundary,
 * so this codec only deals with JSON serialization.
 */

import {
  SemanticMessage,
  SUPPORTED_VERSION,
  VALID_EMOTIONS,
} from './SemanticMessageTypes';

// ── Codec Errors ──────────────────────────────────────────────────

export class SemanticCodecError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = 'SemanticCodecError';
  }
}

// ── Encode ────────────────────────────────────────────────────────

/**
 * Encode a SemanticMessage to a JSON string.
 *
 * @throws {SemanticCodecError} if the message fails validation
 */
export function encode(message: SemanticMessage): string {
  validate(message);
  return JSON.stringify(message);
}

// ── Decode ────────────────────────────────────────────────────────

/**
 * Decode a JSON string to a SemanticMessage.
 *
 * @throws {SemanticCodecError} if JSON is malformed or message is invalid
 */
export function decode(serialized: string): SemanticMessage {
  if (!serialized || typeof serialized !== 'string') {
    throw new SemanticCodecError(
      'Cannot decode: input is not a non-empty string',
      'INVALID_INPUT',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new SemanticCodecError(
      'Cannot decode: malformed JSON',
      'MALFORMED_JSON',
    );
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new SemanticCodecError(
      'Cannot decode: JSON root is not an object',
      'INVALID_JSON_ROOT',
    );
  }

  const obj = parsed as Record<string, unknown>;
  const message: SemanticMessage = {
    version: typeof obj.version === 'number' ? obj.version : -1,
    messageId: typeof obj.messageId === 'string' ? obj.messageId : '',
    text: typeof obj.text === 'string' ? obj.text : '',
    language: typeof obj.language === 'string' ? obj.language : '',
    emotion: (typeof obj.emotion === 'string' ? obj.emotion : '') as any,
    emotionConfidence:
      typeof obj.emotionConfidence === 'number' ? obj.emotionConfidence : -1,
    voiceProfile:
      typeof obj.voiceProfile === 'string' ? obj.voiceProfile : '',
  };

  validate(message);
  return message;
}

// ── Validate ──────────────────────────────────────────────────────

/**
 * Validate a SemanticMessage. Throws on invalid data.
 */
export function validate(message: SemanticMessage): void {
  if (!message || typeof message !== 'object') {
    throw new SemanticCodecError(
      'Validation failed: message is not an object',
      'INVALID_MESSAGE',
    );
  }

  // Version
  if (typeof message.version !== 'number' || message.version < 0) {
    throw new SemanticCodecError(
      'Validation failed: version must be a non-negative number',
      'INVALID_VERSION',
    );
  }
  if (message.version !== SUPPORTED_VERSION) {
    throw new SemanticCodecError(
      `Validation failed: unsupported version ${message.version} (supported: ${SUPPORTED_VERSION})`,
      'UNSUPPORTED_VERSION',
    );
  }

  // messageId
  if (!message.messageId || typeof message.messageId !== 'string') {
    throw new SemanticCodecError(
      'Validation failed: messageId is required and must be a non-empty string',
      'MISSING_MESSAGE_ID',
    );
  }

  // text
  if (!message.text || typeof message.text !== 'string' || !message.text.trim()) {
    throw new SemanticCodecError(
      'Validation failed: text must be a non-empty string',
      'EMPTY_TEXT',
    );
  }

  // language
  if (!message.language || typeof message.language !== 'string') {
    throw new SemanticCodecError(
      'Validation failed: language must be a non-empty string',
      'INVALID_LANGUAGE',
    );
  }

  // emotion
  if (
    typeof message.emotion !== 'string' ||
    !VALID_EMOTIONS.includes(message.emotion as any)
  ) {
    throw new SemanticCodecError(
      `Validation failed: emotion must be one of [${VALID_EMOTIONS.join(', ')}]`,
      'INVALID_EMOTION',
    );
  }

  // emotionConfidence
  if (
    typeof message.emotionConfidence !== 'number' ||
    message.emotionConfidence < 0 ||
    message.emotionConfidence > 1
  ) {
    throw new SemanticCodecError(
      'Validation failed: emotionConfidence must be a number in [0, 1]',
      'INVALID_CONFIDENCE',
    );
  }

  // voiceProfile
  if (!message.voiceProfile || typeof message.voiceProfile !== 'string') {
    throw new SemanticCodecError(
      'Validation failed: voiceProfile must be a non-empty string',
      'INVALID_VOICE_PROFILE',
    );
  }
}

// ── Safe Helpers ──────────────────────────────────────────────────

/**
 * Attempt to decode; returns the message or null if invalid.
 */
export function safeDecode(serialized: string): SemanticMessage | null {
  try {
    return decode(serialized);
  } catch {
    return null;
  }
}

/**
 * Get the byte length of the encoded JSON for a message.
 * Useful for payload-size diagnostics.
 */
export function getEncodedByteLength(message: SemanticMessage): number {
  // React Native does not have TextEncoder, so count UTF-8 bytes manually.
  const str = JSON.stringify(message);
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}
