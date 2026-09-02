/**
 * V9A BitChat ANNOUNCE Payload Codec
 *
 * Minimal ANNOUNCE payload format:
 *   bytes 0–7   nodeId UInt64 BE
 *   byte  8      announce protocol version = 0x01
 *
 * Total: 9 bytes.
 */

import { ANNOUNCE_PAYLOAD_SIZE, ANNOUNCE_PROTOCOL_VERSION } from './core/BitChatConstants';
import { readUInt64BE, writeUInt64BE, isValidNodeId } from './core/BitChatPacket';
import type { NodeId } from './core/BitChatTypes';

/**
 * Encode a NodeId into a 9-byte ANNOUNCE payload.
 *
 * @param nodeId  The announcing node's ID.
 * @returns 9-byte Uint8Array.
 * @throws If nodeId is invalid.
 */
export function encodeAnnounce(nodeId: NodeId): Uint8Array {
  if (!isValidNodeId(nodeId)) {
    throw new Error(`Invalid nodeId for ANNOUNCE: "${nodeId}"`);
  }

  const buf = new Uint8Array(ANNOUNCE_PAYLOAD_SIZE);
  writeUInt64BE(buf, 0, nodeId);
  buf[8] = ANNOUNCE_PROTOCOL_VERSION;
  return buf;
}

/**
 * Decode a 9-byte ANNOUNCE payload.
 *
 * @param payload  The payload bytes.
 * @returns The decoded NodeId.
 * @throws If the payload is wrong length, has invalid version, or malformed nodeId.
 */
export function decodeAnnounce(payload: Uint8Array): NodeId {
  if (payload.length !== ANNOUNCE_PAYLOAD_SIZE) {
    throw new Error(`ANNOUNCE payload must be exactly ${ANNOUNCE_PAYLOAD_SIZE} bytes, got ${payload.length}`);
  }

  const version = payload[8];
  if (version !== ANNOUNCE_PROTOCOL_VERSION) {
    throw new Error(`Invalid ANNOUNCE version: 0x${version.toString(16)}`);
  }

  const nodeId = readUInt64BE(payload, 0) as NodeId;

  if (!isValidNodeId(nodeId)) {
    throw new Error(`Invalid nodeId in ANNOUNCE payload`);
  }

  return nodeId;
}

/**
 * Safely decode an ANNOUNCE payload. Returns null on failure.
 */
export function safeDecodeAnnounce(payload: Uint8Array): NodeId | null {
  try {
    return decodeAnnounce(payload);
  } catch {
    return null;
  }
}
