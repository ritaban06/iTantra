/**
 * V9A BitChat Packet — UInt64 Identifier Helpers
 *
 * Provides strict normalization and validation for NodeId and PacketId.
 * Uses BigInt internally for exact UInt64 representation.
 * No floating-point precision loss.
 */

import type { NodeId, PacketId } from './BitChatTypes';

/** Maximum UInt64 value as BigInt. */
const UINT64_MAX = BigInt('18446744073709551615');

/**
 * Normalize a BigInt or numeric value to a NodeId hex string.
 *
 * @param value  BigInt, number, or string (decimal or hex) to normalize.
 * @returns Normalized NodeId: "0x" + exactly 16 lowercase hex digits.
 * @throws If the value is negative, exceeds UInt64 range, or is not finite.
 */
export function normalizeNodeId(value: bigint | number | string): NodeId {
  return normalizeUInt64(value);
}

/**
 * Normalize a BigInt or numeric value to a PacketId hex string.
 *
 * @param value  BigInt, number, or string (decimal or hex) to normalize.
 * @returns Normalized PacketId: "0x" + exactly 16 lowercase hex digits.
 * @throws If the value is negative, exceeds UInt64 range, or is not finite.
 */
export function normalizePacketId(value: bigint | number | string): PacketId {
  return normalizeUInt64(value);
}

/**
 * Validate that a string is a properly formatted NodeId.
 *
 * @returns true if the string matches the exact NodeId format.
 */
export function isValidNodeId(value: string): value is NodeId {
  return isValidUInt64Hex(value);
}

/**
 * Validate that a string is a properly formatted PacketId.
 *
 * @returns true if the string matches the exact PacketId format.
 */
export function isValidPacketId(value: string): value is PacketId {
  return isValidUInt64Hex(value);
}

// ── Internal Helpers ─────────────────────────────────────────────

/**
 * Core UInt64 normalization. Converts any numeric input to "0x" + 16 hex digits.
 */
function normalizeUInt64(value: bigint | number | string): string {
  let bigVal: bigint;

  if (typeof value === 'bigint') {
    bigVal = value;
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid UInt64: ${value} is not a finite number`);
    }
    if (!Number.isInteger(value)) {
      throw new Error(`Invalid UInt64: ${value} is not an integer`);
    }
    if (value < 0) {
      throw new Error(`Invalid UInt64: ${value} is negative`);
    }
    bigVal = BigInt(value);
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    // Try parsing as hex (with or without 0x prefix) or decimal
    if (/^0x[0-9a-fA-F]+$/.test(trimmed)) {
      bigVal = BigInt(trimmed);
    } else if (/^[0-9]+$/.test(trimmed)) {
      bigVal = BigInt(trimmed);
    } else {
      throw new Error(`Invalid UInt64 string: "${value}"`);
    }
  } else {
    throw new Error(`Invalid UInt64 input: expected bigint, number, or string`);
  }

  if (bigVal < BigInt(0)) {
    throw new Error(`Invalid UInt64: value is negative`);
  }

  if (bigVal > UINT64_MAX) {
    throw new Error(`Invalid UInt64: value exceeds maximum (${UINT64_MAX})`);
  }

  // Format as "0x" + 16 lowercase hex digits, zero-padded
  const hex = bigVal.toString(16).padStart(16, '0');
  return `0x${hex}`;
}

/**
 * Validate that a string is exactly "0x" + 16 lowercase hex digits.
 */
function isValidUInt64Hex(value: string): boolean {
  return /^0x[0-9a-f]{16}$/.test(value);
}

// ── Read/Write UInt64 BE Helpers ────────────────────────────────

/**
 * Write a UInt64 (as hex string) to a Uint8Array in big-endian order.
 */
export function writeUInt64BE(buf: Uint8Array, offset: number, nodeId: NodeId | PacketId): void {
  const bigVal = BigInt(nodeId);
  for (let i = 0; i < 8; i++) {
    buf[offset + i] = Number((bigVal >> BigInt(56 - i * 8)) & BigInt(0xff));
  }
}

/**
 * Read a UInt64 from a Uint8Array in big-endian order and return as hex string.
 */
export function readUInt64BE(buf: Uint8Array, offset: number): string {
  let value = BigInt(0);
  for (let i = 0; i < 8; i++) {
    value = (value << BigInt(8)) | BigInt(buf[offset + i] & 0xff);
  }
  const hex = value.toString(16).padStart(16, '0');
  return `0x${hex}`;
}
