/**
 * V9A BitChat Types
 *
 * Type definitions for the BitChat mesh protocol.
 * NodeId and PacketId are UInt64 values represented as fixed-width
 * lowercase hex strings: "0x" + exactly 16 hex digits.
 */

// ── UInt64 Identifiers ───────────────────────────────────────────

/**
 * A UInt64 node identifier as a normalized hex string.
 * Format: "0x" + exactly 16 lowercase hex digits.
 * Example: "0x0000000000000001"
 */
export type NodeId = string;

/**
 * A UInt64 packet identifier as a normalized hex string.
 * Format: "0x" + exactly 16 lowercase hex digits.
 * Example: "0x0000000000000042"
 */
export type PacketId = string;

// ── Packet Types ─────────────────────────────────────────────────

/** BitChat packet type discriminator. */
export type BitChatPacketType = typeof import('./BitChatConstants').PACKET_TYPE_DATA
  | typeof import('./BitChatConstants').PACKET_TYPE_ANNOUNCE;

// ── Flags ────────────────────────────────────────────────────────

/** BitChat flags byte. All bits are reserved/zero in V9A. */
export type BitChatFlags = number;

// ── Packet ───────────────────────────────────────────────────────

/**
 * A decoded BitChat mesh packet.
 */
export interface BitChatPacket {
  /** Protocol version (currently 0x01). */
  version: number;

  /** Packet type: DATA (0x01) or ANNOUNCE (0x02). */
  packetType: number;

  /** Time-to-live: number of remaining hops (0..255). */
  ttl: number;

  /** UInt64 source node ID (normalized hex string). */
  sourceNodeId: NodeId;

  /** UInt64 packet identifier (normalized hex string). */
  packetId: PacketId;

  /** Flags byte (reserved, currently all zero). */
  flags: BitChatFlags;

  /** Opaque payload bytes. */
  payload: Uint8Array;
}
