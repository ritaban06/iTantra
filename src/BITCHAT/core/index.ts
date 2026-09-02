/**
 * V9A BitChat Core — Public API
 */

// ── Constants ────────────────────────────────────────────────────

export {
  HEADER_SIZE,
  PROTOCOL_VERSION,
  PACKET_TYPE_DATA,
  PACKET_TYPE_ANNOUNCE,
  PACKET_TYPE_DISCOVERY,
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
} from './BitChatConstants';

// ── Types ────────────────────────────────────────────────────────

export type {
  NodeId,
  PacketId,
  BitChatPacketType,
  BitChatFlags,
  BitChatPacket,
} from './BitChatTypes';

// ── Identifier Helpers ───────────────────────────────────────────

export {
  normalizeNodeId,
  normalizePacketId,
  isValidNodeId,
  isValidPacketId,
  writeUInt64BE,
  readUInt64BE,
} from './BitChatPacket';

// ── Packet Codec ─────────────────────────────────────────────────

export {
  encode,
  decode,
  safeDecode,
} from './BitChatPacketCodec';
