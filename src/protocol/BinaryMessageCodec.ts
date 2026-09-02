/**
 * V6A Binary Semantic Protocol — Codec
 *
 * Encodes/decodes SemanticMessage ↔ compact binary Uint8Array.
 *
 * Wire format (all multi-byte integers BIG_ENDIAN):
 *
 *   Byte  0      : version      (UInt8)   — 0x02
 *   Byte  1      : messageType  (UInt8)   — 0x01 = TEXT
 *   Byte  2      : language     (UInt8)   — numeric language code
 *   Byte  3      : emotion      (UInt8)   — 0x00=neutral, 0x01=happy, 0x02=sad, 0x03=angry
 *   Byte  4      : confidence   (UInt8)   — round(emotionConfidence × 255), clamped 0..255
 *   Byte  5      : voiceProfile (UInt8)   — 0x00=default
 *   Bytes 6–13   : messageId    (UInt64)  — FNV-1a 64-bit hash of the string messageId
 *   Bytes 14–17  : textLength   (UInt32)  — byte length of UTF-8 text payload
 *   Bytes 18…    : text         (N bytes) — UTF-8 transcript text
 *
 * Total packet size: 18 + textLength
 *
 * Note: TextEncoder/TextDecoder are NOT available in this React Native
 * environment, so manual UTF-8 encode/decode is implemented below.
 */

import { SemanticMessage } from '../semantic/SemanticMessageTypes';
import { safeDecode as decodeV4Json } from '../semantic/SemanticMessageCodec';
import {
  PROTOCOL_VERSION,
  MSG_TYPE_TEXT,
  VALID_MESSAGE_TYPES,
  LANGUAGE_REGISTRY,
  LANGUAGE_CODE_TO_ISO,
  VALID_LANGUAGE_CODES,
  EMOTION_REGISTRY,
  EMOTION_CODE_TO_LABEL,
  VALID_EMOTION_CODES,
  VOICE_PROFILE_REGISTRY,
  VOICE_PROFILE_CODE_TO_LABEL,
  VALID_VOICE_PROFILE_CODES,
  HEADER_SIZE,
  MAX_BLE_PAYLOAD,
} from './BinaryMessageTypes';

// ── Codec Errors ──────────────────────────────────────────────────

export class BinaryCodecError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = 'BinaryCodecError';
  }
}

// ── FNV-1a 64-bit Hash ───────────────────────────────────────────

/**
 * FNV-1a 64-bit hash of a UTF-8 byte sequence.
 * Used to convert the string messageId to a compact UInt64 wire representation.
 *
 * Algorithm:
 *   hash = 0xcbf29ce484222325 (offset basis)
 *   for each byte:
 *     hash = hash XOR byte
 *     hash = hash × 0x100000001b3 (FNV prime)
 *   return hash
 *
 * We use BigInt for 64-bit arithmetic in JavaScript.
 */
export function fnv1a64(utf8Bytes: Uint8Array): bigint {
  let hash = BigInt('0xcbf29ce484222325');
  const prime = BigInt('0x100000001b3');
  for (let i = 0; i < utf8Bytes.length; i++) {
    hash ^= BigInt(utf8Bytes[i]);
    hash = (hash * prime) & BigInt('0xffffffffffffffff');
  }
  return hash;
}

/**
 * Convenience: hash a string messageId (first encode to UTF-8, then FNV-1a).
 */
export function hashMessageId(messageId: string): bigint {
  const bytes = utf8Encode(messageId);
  return fnv1a64(bytes);
}

// ── Manual UTF-8 Helpers ──────────────────────────────────────────
// React Native Hermes does not provide TextEncoder/TextDecoder globally.
// These manual implementations handle all BMP + supplementary plane characters.

/**
 * Encode a JavaScript string to a UTF-8 Uint8Array.
 *
 * Handles:
 *   - ASCII (U+0000..U+007F) → 1 byte
 *   - Latin/Cyrillic/Devanagari/Bengali (U+0080..U+FFFF) → 2-3 bytes
 *   - Emoji/supplementary (U+10000..U+10FFFF) → 4 bytes (surrogate pairs)
 */
function utf8Encode(str: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);

    // Handle surrogate pairs (supplementary plane characters like emoji)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        // Decode surrogate pair to code point
        code = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
        i++; // skip the low surrogate
      }
    }

    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      // Supplementary plane (U+10000..U+10FFFF)
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}

/**
 * Decode a UTF-8 Uint8Array to a JavaScript string.
 *
 * Throws if the byte sequence is not valid UTF-8.
 */
function utf8Decode(bytes: Uint8Array): string {
  const chars: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    let codePoint: number;
    let seqLen: number;

    if (b0 < 0x80) {
      codePoint = b0;
      seqLen = 1;
    } else if ((b0 & 0xe0) === 0xc0) {
      codePoint = b0 & 0x1f;
      seqLen = 2;
    } else if ((b0 & 0xf0) === 0xe0) {
      codePoint = b0 & 0x0f;
      seqLen = 3;
    } else if ((b0 & 0xf8) === 0xf0) {
      codePoint = b0 & 0x07;
      seqLen = 4;
    } else {
      throw new Error(`Invalid UTF-8 start byte: 0x${b0.toString(16)}`);
    }

    // Check we have enough bytes
    if (i + seqLen > bytes.length) {
      throw new Error(
        `Truncated UTF-8 sequence: expected ${seqLen} bytes, have ${bytes.length - i}`,
      );
    }

    // Decode continuation bytes
    for (let j = 1; j < seqLen; j++) {
      const bj = bytes[i + j];
      if ((bj & 0xc0) !== 0x80) {
        throw new Error(
          `Invalid UTF-8 continuation byte: 0x${bj.toString(16)} at offset ${i + j}`,
        );
      }
      codePoint = (codePoint << 6) | (bj & 0x3f);
    }

    // Validate code point range
    if (
      (seqLen === 2 && codePoint < 0x80) ||
      (seqLen === 3 && codePoint < 0x800) ||
      (seqLen === 4 && codePoint < 0x10000)
    ) {
      throw new Error(`Overlong UTF-8 encoding at offset ${i}`);
    }

    // Encode to string (handle supplementary plane via surrogate pair)
    if (codePoint <= 0xffff) {
      chars.push(String.fromCharCode(codePoint));
    } else {
      codePoint -= 0x10000;
      chars.push(
        String.fromCharCode(0xd800 + (codePoint >> 10)),
        String.fromCharCode(0xdc00 + (codePoint & 0x3ff)),
      );
    }

    i += seqLen;
  }
  return chars.join('');
}

/**
 * Count the number of UTF-8 bytes a string would occupy.
 */
function utf8ByteLength(str: string): number {
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
        i++;
      }
    }
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

// ── Encode ────────────────────────────────────────────────────────

/**
 * Internal: build a V6A packet from a validated SemanticMessage.
 *
 * Performs no size validation — the caller decides whether to enforce
 * transport limits. This is the shared implementation for both encode()
 * and encodeUnrestricted().
 */
function buildPacket(message: SemanticMessage): Uint8Array {
  // Encode text to UTF-8.
  const textBytes = utf8Encode(message.text);
  const textLength = textBytes.length;

  // Allocate the packet buffer.
  const totalSize = HEADER_SIZE + textLength;
  const packet = new Uint8Array(totalSize);

  // Byte 0: version
  packet[0] = PROTOCOL_VERSION;

  // Byte 1: message type (V6A only supports TEXT)
  packet[1] = MSG_TYPE_TEXT;

  // Byte 2: language
  packet[2] = LANGUAGE_REGISTRY[message.language] ?? LANGUAGE_REGISTRY.unknown;

  // Byte 3: emotion
  packet[3] = EMOTION_REGISTRY[message.emotion] ?? EMOTION_REGISTRY.neutral;

  // Byte 4: confidence (UInt8)
  packet[4] = Math.round(Math.min(1, Math.max(0, message.emotionConfidence)) * 255);

  // Byte 5: voice profile
  packet[5] = VOICE_PROFILE_REGISTRY[message.voiceProfile] ?? VOICE_PROFILE_REGISTRY.default;

  // Bytes 6–13: messageId (UInt64 BIG_ENDIAN)
  const compactId = hashMessageId(message.messageId);
  writeUInt64BE(packet, 6, compactId);

  // Bytes 14–17: textLength (UInt32 BIG_ENDIAN)
  writeUInt32BE(packet, 14, textLength);

  // Bytes 18+: UTF-8 text
  packet.set(textBytes, HEADER_SIZE);

  return packet;
}

/**
 * Encode a SemanticMessage to a V6A binary packet (Uint8Array).
 *
 * Enforces the BLE payload limit (509 bytes). Throws PAYLOAD_TOO_LARGE
 * if the encoded packet exceeds this limit.
 *
 * For V7 fragmentation of oversized packets, use encodeUnrestricted().
 *
 * @throws {BinaryCodecError} if the message fails validation or exceeds BLE limit.
 */
export function encode(message: SemanticMessage): Uint8Array {
  validateSemanticMessage(message);
  const packet = buildPacket(message);

  if (packet.length > MAX_BLE_PAYLOAD) {
    throw new BinaryCodecError(
      `Encoded packet (${packet.length} bytes) exceeds BLE payload limit (${MAX_BLE_PAYLOAD} bytes)`,
      'PAYLOAD_TOO_LARGE',
    );
  }

  return packet;
}

/**
 * Encode a SemanticMessage to a V6A binary packet without the BLE size limit.
 *
 * Produces the exact same V6A wire format as encode(). The only difference
 * is that packets > 509 bytes are permitted, enabling V7 fragmentation of
 * oversized messages.
 *
 * @throws {BinaryCodecError} if the message fails validation.
 */
export function encodeUnrestricted(message: SemanticMessage): Uint8Array {
  validateSemanticMessage(message);
  return buildPacket(message);
}

// ── Decode ────────────────────────────────────────────────────────

/**
 * Decode a V6A binary packet (Uint8Array) to a SemanticMessage.
 *
 * The decoded SemanticMessage will have:
 * - All fields populated from the binary header
 * - messageId: the compact UInt64 hash as a hex string (e.g., "0x1a2b3c4d5e6f7a8b")
 *   The original string messageId is NOT recoverable from the wire format.
 *
 * @throws {BinaryCodecError} if the packet is malformed or invalid.
 */
export function decode(data: Uint8Array): SemanticMessage {
  // ── Minimum length check ──────────────────────────────────────
  if (!(data instanceof Uint8Array) || data.length < HEADER_SIZE) {
    throw new BinaryCodecError(
      `Packet too short: ${data?.length ?? 0} bytes (minimum ${HEADER_SIZE})`,
      'PACKET_TOO_SHORT',
    );
  }

  // ── Version check ─────────────────────────────────────────────
  const version = data[0];
  if (version !== PROTOCOL_VERSION) {
    throw new BinaryCodecError(
      `Unsupported protocol version: 0x${version.toString(16)} (expected 0x${PROTOCOL_VERSION.toString(16)})`,
      'UNSUPPORTED_VERSION',
    );
  }

  // ── Message type check ────────────────────────────────────────
  const messageType = data[1];
  if (!VALID_MESSAGE_TYPES.has(messageType)) {
    throw new BinaryCodecError(
      `Invalid message type: 0x${messageType.toString(16)}`,
      'INVALID_MESSAGE_TYPE',
    );
  }

  // ── Language check ────────────────────────────────────────────
  const languageCode = data[2];
  if (!VALID_LANGUAGE_CODES.has(languageCode)) {
    throw new BinaryCodecError(
      `Invalid language code: 0x${languageCode.toString(16)}`,
      'INVALID_LANGUAGE',
    );
  }

  // ── Emotion check ─────────────────────────────────────────────
  const emotionCode = data[3];
  if (!VALID_EMOTION_CODES.has(emotionCode)) {
    throw new BinaryCodecError(
      `Invalid emotion code: 0x${emotionCode.toString(16)}`,
      'INVALID_EMOTION',
    );
  }

  // ── Voice profile check ───────────────────────────────────────
  const voiceProfileCode = data[5];
  if (!VALID_VOICE_PROFILE_CODES.has(voiceProfileCode)) {
    throw new BinaryCodecError(
      `Invalid voice profile code: 0x${voiceProfileCode.toString(16)}`,
      'INVALID_VOICE_PROFILE',
    );
  }

  // ── Read textLength (UInt32 BIG_ENDIAN) ───────────────────────
  const textLength = readUInt32BE(data, 14);

  // ── Validate textLength ───────────────────────────────────────
  if (textLength === 0) {
    throw new BinaryCodecError('Text payload is empty (textLength = 0)', 'EMPTY_TEXT');
  }
  const expectedPacketSize = HEADER_SIZE + textLength;
  if (data.length < expectedPacketSize) {
    throw new BinaryCodecError(
      `Packet truncated: expected ${expectedPacketSize} bytes (header ${HEADER_SIZE} + text ${textLength}), got ${data.length}`,
      'PACKET_TRUNCATED',
    );
  }

  // ── Decode text (UTF-8) ───────────────────────────────────────
  const textBytes = data.slice(HEADER_SIZE, HEADER_SIZE + textLength);
  let text: string;
  try {
    text = utf8Decode(textBytes);
  } catch (e: any) {
    throw new BinaryCodecError(`Invalid UTF-8 in text payload: ${e.message}`, 'INVALID_UTF8');
  }
  if (!text.trim()) {
    throw new BinaryCodecError('Text payload is whitespace-only', 'EMPTY_TEXT');
  }

  // ── Read messageId compact hash (UInt64 BIG_ENDIAN) ───────────
  const compactId = readUInt64BE(data, 6);

  // ── Read confidence ───────────────────────────────────────────
  const confidenceByte = data[4];
  const emotionConfidence = confidenceByte / 255.0;

  // ── Assemble SemanticMessage ──────────────────────────────────
  const language = LANGUAGE_CODE_TO_ISO[languageCode] ?? 'unknown';
  const emotion = EMOTION_CODE_TO_LABEL[emotionCode] as SemanticMessage['emotion'];
  const voiceProfile = VOICE_PROFILE_CODE_TO_LABEL[voiceProfileCode] ?? 'default';

  return {
    version: PROTOCOL_VERSION,
    messageId: `0x${compactId.toString(16).padStart(16, '0')}`,
    text,
    language,
    emotion,
    emotionConfidence,
    voiceProfile,
  };
}

// ── Safe Decode ───────────────────────────────────────────────────

/**
 * Attempt to decode a V6A binary packet.
 * Returns the SemanticMessage or null if invalid.
 */
export function safeDecode(data: Uint8Array): SemanticMessage | null {
  try {
    return decode(data);
  } catch {
    return null;
  }
}

/**
 * Decode with V4 JSON fallback.
 *
 * Detection logic:
 *   data[0] === 0x02 → V6A binary
 *   data[0] === 0x7B ( '{' ) → attempt V4 JSON
 *   otherwise → reject
 *
 * This allows old V4 JSON messages to continue working during transition.
 */
export function decodeWithFallback(data: Uint8Array | string): SemanticMessage | null {
  // If input is a string, it's V4 JSON.
  if (typeof data === 'string') {
    return decodeV4Json(data);
  }

  if (!(data instanceof Uint8Array) || data.length === 0) {
    return null;
  }

  const firstByte = data[0];

  // V6A binary protocol
  if (firstByte === PROTOCOL_VERSION) {
    return safeDecode(data);
  }

  // V4 JSON (first byte is '{' = 0x7B)
  if (firstByte === 0x7b) {
    try {
      const jsonString = utf8Decode(data);
      return decodeV4Json(jsonString);
    } catch {
      return null;
    }
  }

  // Unknown format
  return null;
}

// ── Validate ──────────────────────────────────────────────────────

/**
 * Validate a V6A binary packet without fully decoding.
 * Returns { valid: true } or { valid: false, error: string, code: string }.
 */
export function validatePacket(
  data: Uint8Array,
): { valid: true } | { valid: false; error: string; code: string } {
  try {
    decode(data);
    return { valid: true };
  } catch (e: any) {
    return {
      valid: false,
      error: e.message,
      code: e.code ?? 'UNKNOWN',
    };
  }
}

/**
 * Validate a SemanticMessage before encoding.
 * Throws BinaryCodecError on invalid fields.
 */
function validateSemanticMessage(message: SemanticMessage): void {
  if (!message || typeof message !== 'object') {
    throw new BinaryCodecError('Message is not an object', 'INVALID_MESSAGE');
  }
  if (typeof message.messageId !== 'string' || !message.messageId) {
    throw new BinaryCodecError('messageId is required', 'MISSING_MESSAGE_ID');
  }
  if (typeof message.text !== 'string' || !message.text.trim()) {
    throw new BinaryCodecError('text must be non-empty', 'EMPTY_TEXT');
  }
  if (typeof message.language !== 'string') {
    throw new BinaryCodecError(
      `Invalid language: "${message.language}"`,
      'UNSUPPORTED_LANGUAGE',
    );
  }
  // Unknown/unregistered languages are allowed; they encode as 0x00.
  if (typeof message.emotion !== 'string' || !(message.emotion in EMOTION_REGISTRY)) {
    throw new BinaryCodecError(
      `Unsupported emotion: "${message.emotion}"`,
      'INVALID_EMOTION',
    );
  }
  if (
    typeof message.emotionConfidence !== 'number'
  ) {
    throw new BinaryCodecError(
      'emotionConfidence must be a number',
      'INVALID_CONFIDENCE',
    );
  }
  // Values outside [0,1] are allowed; they will be clamped during encode.
  if (typeof message.voiceProfile !== 'string' || !(message.voiceProfile in VOICE_PROFILE_REGISTRY)) {
    throw new BinaryCodecError(
      `Unsupported voiceProfile: "${message.voiceProfile}"`,
      'INVALID_VOICE_PROFILE',
    );
  }
}

// ── Packet Size Helper ────────────────────────────────────────────

/**
 * Get the exact byte length of the encoded binary packet for a given message.
 * Does NOT actually encode — computes the size from the text's UTF-8 byte length.
 */
export function getEncodedByteLength(message: SemanticMessage): number {
  return HEADER_SIZE + utf8ByteLength(message.text);
}

// ── BIG_ENDIAN Integer Helpers ────────────────────────────────────

/** Write a UInt32 in BIG_ENDIAN at the given offset. */
function writeUInt32BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

/** Read a UInt32 in BIG_ENDIAN from the given offset. */
function readUInt32BE(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset] & 0xff) << 24) |
    ((buf[offset + 1] & 0xff) << 16) |
    ((buf[offset + 2] & 0xff) << 8) |
    (buf[offset + 3] & 0xff)
  );
}

/**
 * Write a UInt64 (as bigint) in BIG_ENDIAN at the given offset.
 */
function writeUInt64BE(buf: Uint8Array, offset: number, value: bigint): void {
  for (let i = 0; i < 8; i++) {
    buf[offset + i] = Number((value >> BigInt(56 - i * 8)) & BigInt(0xff));
  }
}

/**
 * Read a UInt64 in BIG_ENDIAN from the given offset as a bigint.
 */
function readUInt64BE(buf: Uint8Array, offset: number): bigint {
  let value = BigInt(0);
  for (let i = 0; i < 8; i++) {
    value = (value << BigInt(8)) | BigInt(buf[offset + i] & 0xff);
  }
  return value;
}
