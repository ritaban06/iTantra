/**
 * V9A BitChat — Public API
 *
 * Mesh networking foundation for iTantra.
 * Independent from src/protocol — does not modify V6A/V6B/V7/V8.
 */

// ── Core ─────────────────────────────────────────────────────────

export {
  HEADER_SIZE,
  PROTOCOL_VERSION,
  PACKET_TYPE_DATA,
  PACKET_TYPE_ANNOUNCE,
  VALID_PACKET_TYPES,
  FLAGS_NONE,
  NODE_ID_BROADCAST,
  DEFAULT_TTL,
  MAX_TTL,
  DEDUP_MAX_ENTRIES,
  DEDUP_RETENTION_MS,
  PEER_STALE_THRESHOLD_MS,
  ANNOUNCE_PAYLOAD_SIZE,
  ANNOUNCE_PROTOCOL_VERSION,
} from './core';

export type {
  NodeId,
  PacketId,
  BitChatPacketType,
  BitChatFlags,
  BitChatPacket,
} from './core';

export {
  normalizeNodeId,
  normalizePacketId,
  isValidNodeId,
  isValidPacketId,
  writeUInt64BE,
  readUInt64BE,
} from './core';

export {
  encode,
  decode,
  safeDecode,
} from './core/BitChatPacketCodec';

// ── ANNOUNCE Payload Codec ──────────────────────────────────────

export {
  encodeAnnounce,
  decodeAnnounce,
  safeDecodeAnnounce,
} from './AnnounceCodec';

// ── Peer ─────────────────────────────────────────────────────────

export type { PeerState, PeerInfo } from './peer';
export { PeerRegistry } from './peer';

// ── Mesh ─────────────────────────────────────────────────────────

export { TTLManager } from './mesh';
export { DedupCache } from './mesh';
export { MeshRouter } from './mesh';
export type { PeerQuery } from './mesh';
export { RelayEngine } from './mesh';
export type { SendToPeerFn, DeliverFn, RelayEngineParams } from './mesh';

// ── Identity ──────────────────────────────────────────────────

export { NodeIdStore } from './NodeIdStore';
export type { StorageBackend } from './NodeIdStore';

// ── BLE Integration ──────────────────────────────────────────

export { BitChatBLEAdapter } from './BitChatBLEAdapter';
export type { BleSendFn, LocalDeliverFn, BitChatBLEAdapterParams } from './BitChatBLEAdapter';
