/**
 * V7 Fragment Codec — Stateless
 *
 * Splits oversized V6A packets into V7 fragments and parses V7 headers.
 *
 * This codec is STATELESS. It owns a group ID counter but does not
 * perform reassembly, track fragments, or manage memory.
 */

import {
  V7_MARKER,
  V7_HEADER_SIZE,
  MAX_FRAGMENTS,
  MAX_CHUNK_SIZE,
  MAX_V6A_LENGTH,
  FragmentHeader,
  FragmentChunk,
  V7FragmentError,
} from './V7FragmentTypes';

// ── Group ID Counter ──────────────────────────────────────────────

const UINT32_MAX = 0xffffffff;

let groupIdCounter = 0;

/**
 * Reset the group ID counter (for testing).
 */
export function resetGroupIdCounter(): void {
  groupIdCounter = 0;
}

/**
 * Get the current group ID counter value (for testing).
 */
export function getGroupIdCounter(): number {
  return groupIdCounter >>> 0;
}

// ── Split ─────────────────────────────────────────────────────────

/**
 * Split a V6A binary packet into V7 fragments.
 *
 * If the V6A packet fits in a single V6B payload (≤ 499 bytes),
 * returns an empty array — the caller should use the single-frame
 * V6B path directly.
 *
 * If the V6A packet exceeds 499 bytes, splits it into fragments
 * of ≤ 490 bytes of V6A data each, each prefixed with a 9-byte
 * V7 header.
 *
 * @param v6aPacket  Complete V6A binary packet.
 * @returns Array of FragmentChunk (empty if no fragmentation needed).
 * @throws {V7FragmentError} if the packet exceeds MAX_V6A_LENGTH.
 */
export function splitV6A(v6aPacket: Uint8Array): FragmentChunk[] {
  // Single-frame: no V7 header needed.
  if (v6aPacket.length <= 499) {
    return [];
  }

  // Validate maximum V6A length.
  if (v6aPacket.length > MAX_V6A_LENGTH) {
    throw new V7FragmentError(
      `V6A packet too large for V7 fragmentation: ${v6aPacket.length} bytes (max ${MAX_V6A_LENGTH})`,
      'V6A_TOO_LARGE',
    );
  }

  // Calculate fragment count.
  const totalFragments = Math.ceil(v6aPacket.length / MAX_CHUNK_SIZE);
  if (totalFragments > MAX_FRAGMENTS) {
    throw new V7FragmentError(
      `Fragment count exceeds maximum: ${totalFragments} (max ${MAX_FRAGMENTS})`,
      'TOO_MANY_FRAGMENTS',
    );
  }

  // Allocate a new group ID.
  const groupId = groupIdCounter >>> 0;
  groupIdCounter = ((groupIdCounter + 1) & UINT32_MAX) >>> 0;

  // Split into chunks.
  const chunks: FragmentChunk[] = [];
  const v6aLength = v6aPacket.length;

  for (let i = 0; i < totalFragments; i++) {
    const offset = i * MAX_CHUNK_SIZE;
    const chunkSize = Math.min(MAX_CHUNK_SIZE, v6aLength - offset);
    const v6aChunk = v6aPacket.slice(offset, offset + chunkSize);

    const header: FragmentHeader = {
      marker: V7_MARKER,
      groupId,
      fragmentIndex: i,
      totalFragments,
      v6aLength,
    };

    // Build the complete fragment payload: [9-byte V7 header][V6A chunk].
    const payload = new Uint8Array(V7_HEADER_SIZE + chunkSize);
    writeHeader(payload, header);
    payload.set(v6aChunk, V7_HEADER_SIZE);

    chunks.push({ payload, header });
  }

  return chunks;
}

// ── Parse Header ──────────────────────────────────────────────────

/**
 * Parse a V7 fragment header from a V6B payload.
 *
 * @param payload  The V6B payload bytes (starts with 0xF7).
 * @returns Parsed FragmentHeader.
 * @throws {V7FragmentError} if the header is malformed.
 */
export function parseHeader(payload: Uint8Array): FragmentHeader {
  if (!(payload instanceof Uint8Array) || payload.length < V7_HEADER_SIZE) {
    throw new V7FragmentError(
      `V7 payload too short: ${payload?.length ?? 0} bytes (minimum ${V7_HEADER_SIZE})`,
      'HEADER_TOO_SHORT',
    );
  }

  const marker = payload[0];
  if (marker !== V7_MARKER) {
    throw new V7FragmentError(
      `Invalid V7 marker: 0x${marker.toString(16)} (expected 0x${V7_MARKER.toString(16)})`,
      'INVALID_MARKER',
    );
  }

  const groupId = readUInt32BE(payload, 1);
  const fragmentIndex = payload[5];
  const totalFragments = payload[6];
  const v6aLength = readUInt16BE(payload, 7);

  // Validate totalFragments.
  if (totalFragments < 1 || totalFragments > MAX_FRAGMENTS) {
    throw new V7FragmentError(
      `Invalid totalFragments: ${totalFragments} (must be 1–${MAX_FRAGMENTS})`,
      'INVALID_TOTAL_FRAGMENTS',
    );
  }

  // Validate fragmentIndex.
  if (fragmentIndex >= totalFragments) {
    throw new V7FragmentError(
      `Invalid fragmentIndex: ${fragmentIndex} (must be < ${totalFragments})`,
      'INVALID_FRAGMENT_INDEX',
    );
  }

  // Validate v6aLength.
  if (v6aLength === 0 || v6aLength > MAX_V6A_LENGTH) {
    throw new V7FragmentError(
      `Invalid v6aLength: ${v6aLength} (must be 1–${MAX_V6A_LENGTH})`,
      'INVALID_V6A_LENGTH',
    );
  }

  return {
    marker,
    groupId,
    fragmentIndex,
    totalFragments,
    v6aLength,
  };
}

// ── Header Encoding ───────────────────────────────────────────────

/**
 * Write a V7 header into a buffer.
 */
function writeHeader(buf: Uint8Array, header: FragmentHeader): void {
  buf[0] = V7_MARKER;
  writeUInt32BE(buf, 1, header.groupId);
  buf[5] = header.fragmentIndex;
  buf[6] = header.totalFragments;
  writeUInt16BE(buf, 7, header.v6aLength);
}

// ── BIG_ENDIAN Helpers ────────────────────────────────────────────

function writeUInt32BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

function readUInt32BE(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset] & 0xff) << 24) |
    ((buf[offset + 1] & 0xff) << 16) |
    ((buf[offset + 2] & 0xff) << 8) |
    (buf[offset + 3] & 0xff)
  );
}

function writeUInt16BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 8) & 0xff;
  buf[offset + 1] = value & 0xff;
}

function readUInt16BE(buf: Uint8Array, offset: number): number {
  return ((buf[offset] & 0xff) << 8) | (buf[offset + 1] & 0xff);
}
