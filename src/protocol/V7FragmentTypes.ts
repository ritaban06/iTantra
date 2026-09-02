/**
 * V7 BLE Fragmentation — Type Constants
 *
 * V7 adds fragmentation metadata inside the V6B payload, allowing
 * V6A packets larger than 499 bytes to be split across multiple
 * BLE frames.
 *
 * V7 header (9 bytes):
 *
 *   Byte  0      : marker         (UInt8)   — 0xF7
 *   Bytes 1–4    : groupId        (UInt32)  — BIG_ENDIAN, logical message group
 *   Byte  5      : fragmentIndex  (UInt8)   — 0–127
 *   Byte  6      : totalFragments (UInt8)   — 1–128
 *   Bytes 7–8    : v6aLength      (UInt16)  — BIG_ENDIAN, total V6A packet length
 *
 * V6A packets ≤ 499 bytes are sent without V7 metadata (single-frame V6B).
 * V6A packets > 499 bytes are split into V7 fragments, each ≤ 490 bytes of V6A data.
 */

// ── Protocol Constants ────────────────────────────────────────────

/** V7 marker byte. Distinguishes V7 payloads from V6A (0x02) and V4 JSON (0x7B). */
export const V7_MARKER = 0xF7;

/** V7 header size in bytes. */
export const V7_HEADER_SIZE = 9;

/** Maximum number of fragments per message. */
export const MAX_FRAGMENTS = 128;

/** Maximum V6A bytes per fragment. Derived: 509 (BLE) − 10 (V6B) − 9 (V7) = 490. */
export const MAX_CHUNK_SIZE = 490;

/** Maximum V6A packet length supported by V7. Derived: 128 × 490 = 62,720. */
export const MAX_V6A_LENGTH = MAX_FRAGMENTS * MAX_CHUNK_SIZE; // 62,720

/** Maximum number of incomplete reassembly groups held simultaneously. */
export const MAX_CONCURRENT_GROUPS = 8;

/** Time-to-live for incomplete groups (ms). Expired groups are discarded. */
export const GROUP_EXPIRY_MS = 30_000;

/** Maximum length for the sourceId portion of a group key. */
export const MAX_GROUP_KEY_LENGTH = 128;

/** Maximum V6B payload that can carry a V7 fragment. */
export const V7_MAX_V6B_PAYLOAD = 499; // V6B max payload

/** Maximum V6B frame that can carry a V7 fragment. */
export const V7_MAX_V6B_FRAME = 509; // BLE max usable

// ── Fragment Header ───────────────────────────────────────────────

/**
 * Parsed V7 fragment header.
 */
export interface FragmentHeader {
  /** V7 marker (always 0xF7). */
  marker: number;
  /** Logical message group identifier. */
  groupId: number;
  /** 0-indexed fragment number (0–127). */
  fragmentIndex: number;
  /** Total number of fragments (1–128). */
  totalFragments: number;
  /** Total byte length of the complete V6A packet. */
  v6aLength: number;
}

/**
 * A complete V7 fragment: header + V6A chunk, ready for V6B wrapping.
 */
export interface FragmentChunk {
  /** The full fragment payload (V7 header + V6A chunk). Goes into V6B payload. */
  payload: Uint8Array;
  /** The fragment header (parsed from the payload). */
  header: FragmentHeader;
}

// ── Reassembly State ──────────────────────────────────────────────

/**
 * Internal reassembly state for one logical message group.
 */
export interface FragmentState {
  /** Source device identifier. */
  sourceId: string;
  /** Group identifier. */
  groupId: number;
  /** Total fragments expected. */
  totalFragments: number;
  /** Total V6A byte length expected. */
  v6aLength: number;
  /** Received fragments keyed by fragment index. */
  fragments: Map<number, Uint8Array>;
  /** Number of distinct fragments received. */
  receivedCount: number;
  /** Timestamp when the first fragment was received (ms). */
  createdAt: number;
  /** Timestamp of the most recently received fragment (ms). */
  lastActivityAt: number;
}

/**
 * Result of attempting to add a fragment to the reassembler.
 */
export type ReassemblyResult =
  | { status: 'incomplete' }
  | { status: 'complete'; v6aPacket: Uint8Array }
  | { status: 'error'; reason: string };

// ── Errors ────────────────────────────────────────────────────────

/**
 * Error thrown by FragmentCodec operations.
 */
export class V7FragmentError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = 'V7FragmentError';
  }
}
