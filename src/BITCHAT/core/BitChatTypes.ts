/**
 * V9A/V9C BitChat Types
 *
 * Type definitions for the BitChat mesh protocol.
 * NodeId and PacketId are UInt64 values represented as fixed-width
 * lowercase hex strings: "0x" + exactly 16 hex digits.
 */

// ── UInt64 Identifiers ───────────────────────────────────────────

/** A UInt64 node identifier as a normalized hex string. */
export type NodeId = string;

/** A UInt64 packet identifier as a normalized hex string. */
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
 *
 * Wire layout (28-byte header):
 *   byte  0       version           (UInt8)
 *   byte  1       packetType        (UInt8)
 *   byte  2       ttl               (UInt8)
 *   bytes 3–10    sourceNodeId      (UInt64 BE)
 *   bytes 11–18   destinationNodeId (UInt64 BE)
 *   bytes 19–26   packetId          (UInt64 BE)
 *   byte  27      flags             (UInt8)
 *   bytes 28+     payload           (N bytes)
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

  /** UInt64 destination node ID (normalized hex string).
   *  0x0000000000000000 = broadcast (for ANNOUNCE or broadcast DATA). */
  destinationNodeId: NodeId;

  /** UInt64 packet identifier (normalized hex string). */
  packetId: PacketId;

  /** Flags byte (reserved, currently all zero). */
  flags: BitChatFlags;

  /** Opaque payload bytes. */
  payload: Uint8Array;
}
