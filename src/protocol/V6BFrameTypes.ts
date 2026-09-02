/**
 * V6B Transport Envelope — Type Constants
 *
 * Wire format (all multi-byte integers BIG_ENDIAN):
 *
 *   Byte  0      : version       (UInt8)   — 0x03
 *   Byte  1      : frameType     (UInt8)   — see FRAME_TYPE_*
 *   Bytes 2–5    : sequence      (UInt32)  — per-sender monotonic counter
 *   Bytes 6–9    : payloadLength (UInt32)  — byte length of payload
 *   Bytes 10…    : payload       (N bytes) — opaque (e.g. V6A packet)
 *
 *   Total: 10 + payloadLength bytes
 *   Must be ≤ 509 bytes (BLE usable payload after ATT overhead).
 */

// ── Protocol Version ──────────────────────────────────────────────

/** V6B transport envelope version byte. */
export const V6B_VERSION = 0x03;

// ── Frame Types ───────────────────────────────────────────────────

/** Payload is a complete V6A binary packet. */
export const V6B_FRAME_V6A_MESSAGE = 0x01;

/** Acknowledgment frame. Payload: 8-byte UInt64 messageId. Defined only. */
export const V6B_FRAME_ACK = 0x10;

/** Negative acknowledgment frame. Payload: 8-byte messageId + 1-byte reason. Defined only. */
export const V6B_FRAME_NACK = 0x11;

/** Ping frame. Payload: empty. Defined only. */
export const V6B_FRAME_PING = 0x21;

/** Pong frame. Payload: empty. Defined only. */
export const V6B_FRAME_PONG = 0x22;

/** Set of all recognized frame types for validation. */
export const V6B_VALID_FRAME_TYPES = new Set([
  V6B_FRAME_V6A_MESSAGE,
  V6B_FRAME_ACK,
  V6B_FRAME_NACK,
  V6B_FRAME_PING,
  V6B_FRAME_PONG,
]);

// ── Size Constants ────────────────────────────────────────────────

/**
 * V6B header size in bytes:
 * version(1) + frameType(1) + sequence(4) + payloadLength(4) = 10
 */
export const V6B_HEADER_SIZE = 10;

/**
 * Maximum usable BLE payload after GATT overhead.
 * Negotiated MTU = 512, ATT overhead = 3, so usable = 509.
 */
export const V6B_MAX_FRAME_SIZE = 509;

/**
 * Maximum V6B payload (everything after the 10-byte header).
 * 509 − 10 = 499
 */
export const V6B_MAX_PAYLOAD_SIZE = V6B_MAX_FRAME_SIZE - V6B_HEADER_SIZE; // 499

// ── Decoded Frame ─────────────────────────────────────────────────

/**
 * Result of decoding a V6B transport frame.
 */
export interface V6BDecodedFrame {
  /** Protocol version (must be 0x03). */
  version: number;
  /** Frame type (one of V6B_FRAME_*). */
  frameType: number;
  /** Per-sender sequence number. */
  sequence: number;
  /** Byte length of payload. */
  payloadLength: number;
  /** Payload bytes (opaque to V6B). */
  payload: Uint8Array;
}

/**
 * Codec error for V6B frame operations.
 */
export class V6BFrameError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = 'V6BFrameError';
  }
}
