/**
 * V9D BitChat DISCOVERY Payload Codec
 *
 * Minimal DISCOVERY payload format:
 *   bytes 0–7   advertisedNodeId UInt64 BE
 *   byte  8      discovery protocol version = 0x01
 *
 * Total: 9 bytes.
 *
 * The advertisedNodeId identifies the node that originated the discovery.
 * This is the same as sourceNodeId in the outer BITCHAT envelope.
 */

import { DISCOVERY_PAYLOAD_SIZE, DISCOVERY_PROTOCOL_VERSION } from './core/BitChatConstants';
import { readUInt64BE, writeUInt64BE, isValidNodeId } from './core/BitChatPacket';
import type { NodeId } from './core/BitChatTypes';

/**
 * Encode a NodeId into a 9-byte DISCOVERY payload.
 *
 * @param nodeId  The node advertising its identity.
 * @returns 9-byte Uint8Array.
 * @throws If nodeId is invalid.
 */
export function encodeDiscovery(nodeId: NodeId): Uint8Array {
  if (!isValidNodeId(nodeId)) {
    throw new Error(`Invalid nodeId for DISCOVERY: "${nodeId}"`);
  }

  const buf = new Uint8Array(DISCOVERY_PAYLOAD_SIZE);
  writeUInt64BE(buf, 0, nodeId);
  buf[8] = DISCOVERY_PROTOCOL_VERSION;
  return buf;
}

/**
 * Decode a 9-byte DISCOVERY payload.
 *
 * @param payload  The payload bytes.
 * @returns The advertised NodeId.
 * @throws If the payload is wrong length, has invalid version, or malformed nodeId.
 */
export function decodeDiscovery(payload: Uint8Array): NodeId {
  if (payload.length !== DISCOVERY_PAYLOAD_SIZE) {
    throw new Error(`DISCOVERY payload must be exactly ${DISCOVERY_PAYLOAD_SIZE} bytes, got ${payload.length}`);
  }

  const version = payload[8];
  if (version !== DISCOVERY_PROTOCOL_VERSION) {
    throw new Error(`Invalid DISCOVERY version: 0x${version.toString(16)}`);
  }

  const nodeId = readUInt64BE(payload, 0) as NodeId;

  if (!isValidNodeId(nodeId)) {
    throw new Error(`Invalid nodeId in DISCOVERY payload`);
  }

  return nodeId;
}

/**
 * Safely decode a DISCOVERY payload. Returns null on failure.
 */
export function safeDecodeDiscovery(payload: Uint8Array): NodeId | null {
  try {
    return decodeDiscovery(payload);
  } catch {
    return null;
  }
}
