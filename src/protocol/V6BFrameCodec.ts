/**
 * V6B Transport Envelope — Codec
 *
 * Encodes/decodes V6B transport frames that wrap opaque payloads
 * (e.g., V6A binary packets).
 *
 * Wire format (all multi-byte integers BIG_ENDIAN):
 *
 *   Byte  0      : version       (UInt8)   — 0x03
 *   Byte  1      : frameType     (UInt8)   — see V6BFrameTypes
 *   Bytes 2–5    : sequence      (UInt32)  — per-sender monotonic counter
 *   Bytes 6–9    : payloadLength (UInt32)  — byte length of payload
 *   Bytes 10…    : payload       (N bytes) — opaque
 *
 *   Total: 10 + payloadLength bytes
 *   Must be ≤ 509 bytes.
 *
 * This codec is STATELESS. It does not own a sequence counter or
 * validate source devices.
 */

import {
  V6B_VERSION,
  V6B_VALID_FRAME_TYPES,
  V6B_HEADER_SIZE,
  V6B_MAX_FRAME_SIZE,
  V6B_MAX_PAYLOAD_SIZE,
  V6BDecodedFrame,
  V6BFrameError,
} from './V6BFrameTypes';

// ── Encode ────────────────────────────────────────────────────────

/**
 * Encode a V6B transport frame.
 *
 * @param sequence     UInt32 sequence number.
 * @param frameType    Frame type (one of V6B_FRAME_*).
 * @param payload      Opaque payload bytes.
 * @returns Encoded V6B frame as Uint8Array.
 * @throws {V6BFrameError} if validation fails.
 */
export function encode(
  sequence: number,
  frameType: number,
  payload: Uint8Array,
): Uint8Array {
  // ── Validate inputs ──────────────────────────────────────────
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffffffff) {
    throw new V6BFrameError(
      `Invalid sequence: ${sequence} (must be UInt32)`,
      'INVALID_SEQUENCE',
    );
  }

  if (!V6B_VALID_FRAME_TYPES.has(frameType)) {
    throw new V6BFrameError(
      `Unknown frame type: 0x${frameType.toString(16)}`,
      'INVALID_FRAME_TYPE',
    );
  }

  if (!(payload instanceof Uint8Array)) {
    throw new V6BFrameError('Payload must be a Uint8Array', 'INVALID_PAYLOAD');
  }

  if (payload.length > V6B_MAX_PAYLOAD_SIZE) {
    throw new V6BFrameError(
      `Payload too large: ${payload.length} bytes (max ${V6B_MAX_PAYLOAD_SIZE})`,
      'PAYLOAD_TOO_LARGE',
    );
  }

  // ── Build frame ──────────────────────────────────────────────
  const frame = new Uint8Array(V6B_HEADER_SIZE + payload.length);

  // Byte 0: version
  frame[0] = V6B_VERSION;

  // Byte 1: frame type
  frame[1] = frameType;

  // Bytes 2–5: sequence (UInt32 BIG_ENDIAN)
  writeUInt32BE(frame, 2, sequence);

  // Bytes 6–9: payloadLength (UInt32 BIG_ENDIAN)
  writeUInt32BE(frame, 6, payload.length);

  // Bytes 10+: payload
  frame.set(payload, V6B_HEADER_SIZE);

  return frame;
}

// ── Decode ────────────────────────────────────────────────────────

/**
 * Decode a V6B transport frame.
 *
 * @param data  Raw bytes to decode.
 * @returns Decoded frame with header fields and payload.
 * @throws {V6BFrameError} if the frame is malformed.
 */
export function decode(data: Uint8Array): V6BDecodedFrame {
  // ── Minimum length check ─────────────────────────────────────
  if (!(data instanceof Uint8Array) || data.length < V6B_HEADER_SIZE) {
    throw new V6BFrameError(
      `Frame too short: ${data?.length ?? 0} bytes (minimum ${V6B_HEADER_SIZE})`,
      'FRAME_TOO_SHORT',
    );
  }

  // ── Version check ────────────────────────────────────────────
  const version = data[0];
  if (version !== V6B_VERSION) {
    throw new V6BFrameError(
      `Unsupported version: 0x${version.toString(16)} (expected 0x${V6B_VERSION.toString(16)})`,
      'UNSUPPORTED_VERSION',
    );
  }

  // ── Frame type check ─────────────────────────────────────────
  const frameType = data[1];
  if (!V6B_VALID_FRAME_TYPES.has(frameType)) {
    throw new V6BFrameError(
      `Unknown frame type: 0x${frameType.toString(16)}`,
      'INVALID_FRAME_TYPE',
    );
  }

  // ── Read sequence (UInt32 BIG_ENDIAN) ────────────────────────
  const sequence = readUInt32BE(data, 2);

  // ── Read payloadLength (UInt32 BIG_ENDIAN) ───────────────────
  const payloadLength = readUInt32BE(data, 6);

  // ── Validate payload length ──────────────────────────────────
  if (payloadLength > V6B_MAX_PAYLOAD_SIZE) {
    throw new V6BFrameError(
      `Payload length exceeds maximum: ${payloadLength} (max ${V6B_MAX_PAYLOAD_SIZE})`,
      'PAYLOAD_TOO_LARGE',
    );
  }

  const expectedFrameSize = V6B_HEADER_SIZE + payloadLength;
  if (data.length < expectedFrameSize) {
    throw new V6BFrameError(
      `Frame truncated: expected ${expectedFrameSize} bytes (header ${V6B_HEADER_SIZE} + payload ${payloadLength}), got ${data.length}`,
      'FRAME_TRUNCATED',
    );
  }

  // ── Extract payload ──────────────────────────────────────────
  const payload = data.slice(V6B_HEADER_SIZE, V6B_HEADER_SIZE + payloadLength);

  return {
    version,
    frameType,
    sequence,
    payloadLength,
    payload,
  };
}

// ── Safe Decode ───────────────────────────────────────────────────

/**
 * Attempt to decode a V6B frame.
 * Returns the decoded frame or null if invalid.
 */
export function safeDecode(data: Uint8Array): V6BDecodedFrame | null {
  try {
    return decode(data);
  } catch {
    return null;
  }
}

// ── Validate ──────────────────────────────────────────────────────

/**
 * Validate a V6B frame without fully decoding.
 * Returns { valid: true } or { valid: false, error, code }.
 */
export function validateFrame(
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

// ── BIG_ENDIAN Helpers ────────────────────────────────────────────

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
