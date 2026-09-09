/**
 * V9A/V9C BitChat Packet Codec
 *
 * Encodes and decodes the BitChat mesh envelope (28-byte header):
 *
 *   byte  0       version           (UInt8)  — 0x01
 *   byte  1       packetType        (UInt8)  — 0x01=DATA, 0x02=ANNOUNCE
 *   byte  2       ttl               (UInt8)  — 0..255
 *   bytes 3–10    sourceNodeId      (UInt64) — BIG_ENDIAN
 *   bytes 11–18   destinationNodeId (UInt64) — BIG_ENDIAN
 *   bytes 19–26   packetId          (UInt64) — BIG_ENDIAN
 *   byte  27      flags             (UInt8)  — reserved, zero
 *   bytes 28+     payload           (N bytes) — opaque
 *
 * Total header: 28 bytes.
 * Payload length: derived from total byte length — 28.
 */

import {
  HEADER_SIZE,
  PROTOCOL_VERSION,
  VALID_PACKET_TYPES,
} from './BitChatConstants';
import type { BitChatPacket, NodeId, PacketId } from './BitChatTypes';
import {
  readUInt64BE,
  writeUInt64BE,
  isValidNodeId,
  isValidPacketId,
} from './BitChatPacket';

// ── Encode ───────────────────────────────────────────────────────

/**
 * Encode a BitChatPacket into a Uint8Array.
 *
 * @throws If the packet has invalid fields.
 */
export function encode(packet: BitChatPacket): Uint8Array {
  if (packet.version !== PROTOCOL_VERSION) {
    throw new Error(`Invalid BitChat version: 0x${packet.version.toString(16)}`);
  }

  if (!VALID_PACKET_TYPES.has(packet.packetType)) {
    throw new Error(`Invalid BitChat packet type: 0x${packet.packetType.toString(16)}`);
  }

  if (typeof packet.ttl !== 'number' || packet.ttl < 0 || packet.ttl > 255 || !Number.isInteger(packet.ttl)) {
    throw new Error(`Invalid TTL: ${packet.ttl}`);
  }

  if (!isValidNodeId(packet.sourceNodeId)) {
    throw new Error(`Invalid sourceNodeId: "${packet.sourceNodeId}"`);
  }
  if (!isValidNodeId(packet.destinationNodeId)) {
    throw new Error(`Invalid destinationNodeId: "${packet.destinationNodeId}"`);
  }
  if (!isValidPacketId(packet.packetId)) {
    throw new Error(`Invalid packetId: "${packet.packetId}"`);
  }

  if (typeof packet.flags !== 'number' || packet.flags < 0 || packet.flags > 255) {
    throw new Error(`Invalid flags: ${packet.flags}`);
  }

  const totalSize = HEADER_SIZE + packet.payload.length;
  const buf = new Uint8Array(totalSize);

  buf[0] = packet.version;
  buf[1] = packet.packetType;
  buf[2] = packet.ttl;
  writeUInt64BE(buf, 3, packet.sourceNodeId);
  writeUInt64BE(buf, 11, packet.destinationNodeId);
  writeUInt64BE(buf, 19, packet.packetId);
  buf[27] = packet.flags;
  buf.set(packet.payload, HEADER_SIZE);

  return buf;
}

// ── Decode ───────────────────────────────────────────────────────

/**
 * Decode a Uint8Array into a BitChatPacket.
 *
 * @throws If the buffer is too short, has an unsupported version,
 *         unknown packet type, or invalid fields.
 */
export function decode(bytes: Uint8Array): BitChatPacket {
  if (bytes.length < HEADER_SIZE) {
    throw new Error(`BitChat packet too short: ${bytes.length} bytes (minimum ${HEADER_SIZE})`);
  }

  const version = bytes[0];
  if (version !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported BitChat version: 0x${version.toString(16)}`);
  }

  const packetType = bytes[1];
  if (!VALID_PACKET_TYPES.has(packetType)) {
    throw new Error(`Unknown BitChat packet type: 0x${packetType.toString(16)}`);
  }

  const ttl = bytes[2];
  if (ttl < 0 || ttl > 255) {
    throw new Error(`Invalid TTL: ${ttl}`);
  }

  const sourceNodeId = readUInt64BE(bytes, 3) as NodeId;
  const destinationNodeId = readUInt64BE(bytes, 11) as NodeId;
  const packetId = readUInt64BE(bytes, 19) as PacketId;
  const flags = bytes[27];

  const payload = bytes.slice(HEADER_SIZE);

  return {
    version,
    packetType,
    ttl,
    sourceNodeId,
    destinationNodeId,
    packetId,
    flags,
    payload,
  };
}

// ── Safe Decode ──────────────────────────────────────────────────

/**
 * Attempt to decode a Uint8Array into a BitChatPacket.
 * Returns null if decoding fails (never throws).
 */
export function safeDecode(bytes: Uint8Array): BitChatPacket | null {
  try {
    return decode(bytes);
  } catch {
    return null;
  }
}
