/**
 * V9A/V9C BitChat Constants
 *
 * Defines the binary protocol constants for the BitChat mesh envelope.
 */

// ── Packet Envelope ──────────────────────────────────────────────

/**
 * Total header size in bytes:
 *   version(1) + packetType(1) + ttl(1) + sourceNodeId(8) + destinationNodeId(8)
 *   + packetId(8) + flags(1) = 28 bytes.
 */
export const HEADER_SIZE = 28;

/** Protocol version for V9A BitChat envelope. */
export const PROTOCOL_VERSION = 0x01;

// ── Packet Types ─────────────────────────────────────────────────

/** DATA packet: carries an opaque payload (e.g. V6B frame). */
export const PACKET_TYPE_DATA = 0x01;

/** ANNOUNCE packet: peer discovery announcement. */
export const PACKET_TYPE_ANNOUNCE = 0x02;

/**
 * DISCOVERY packet: mesh-wide node discovery.
 * Flooded through mesh like DATA. Carries the advertised Node ID.
 * Does NOT modify direct BLE peer mapping.
 */
export const PACKET_TYPE_DISCOVERY = 0x03;

/** Set of recognized packet types for validation. */
export const VALID_PACKET_TYPES = new Set([PACKET_TYPE_DATA, PACKET_TYPE_ANNOUNCE, PACKET_TYPE_DISCOVERY]);

// ── Flags ────────────────────────────────────────────────────────

/** All flags are reserved/zero in V9A. */
export const FLAGS_NONE = 0x00;

// ── Special NodeId ──────────────────────────────────────────────

/**
 * Broadcast destination: packet is intended for all nodes.
 * Used by ANNOUNCE and any future broadcast message types.
 * 0x0000000000000000 is not a valid individual node ID.
 */
export const NODE_ID_BROADCAST = '0x0000000000000000';

// ── TTL ──────────────────────────────────────────────────────────

/** Default TTL assigned to new packets. */
export const DEFAULT_TTL = 5;

/** Maximum allowed TTL value. */
export const MAX_TTL = 5;

// ── Dedup Cache ──────────────────────────────────────────────────

/** Maximum entries in the deduplication cache. */
export const DEDUP_MAX_ENTRIES = 256;

/** Retention time for dedup cache entries in milliseconds. */
export const DEDUP_RETENTION_MS = 60_000;

// ── Peer Registry ────────────────────────────────────────────────

/** Stale threshold in milliseconds — peers older than this are pruned. */
export const PEER_STALE_THRESHOLD_MS = 60_000;

// ── ANNOUNCE Payload ────────────────────────────────────────────

/** ANNOUNCE payload size: nodeId(8) + announceVersion(1) = 9 bytes. */
export const ANNOUNCE_PAYLOAD_SIZE = 9;

/** ANNOUNCE protocol version. */
export const ANNOUNCE_PROTOCOL_VERSION = 0x01;

// ── DISCOVERY Payload ──────────────────────────────────────────

/**
 * DISCOVERY payload size:
 *   advertisedNodeId(8) + discoveryVersion(1) = 9 bytes.
 */
export const DISCOVERY_PAYLOAD_SIZE = 9;

/** DISCOVERY protocol version. */
export const DISCOVERY_PROTOCOL_VERSION = 0x01;

// ── Mesh Discovery Registry ───────────────────────────────────

/** Maximum discovered-node entries. */
export const DISCOVERY_MAX_ENTRIES = 128;

/** Retention time for discovery records in milliseconds. */
export const DISCOVERY_RETENTION_MS = 120_000;
