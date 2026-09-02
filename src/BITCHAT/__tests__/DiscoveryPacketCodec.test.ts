/**
 * V9D Discovery Payload Codec — Tests
 */

import { DISCOVERY_PAYLOAD_SIZE, DISCOVERY_PROTOCOL_VERSION } from '../core/BitChatConstants';
import type { NodeId } from '../core/BitChatTypes';
import { normalizeNodeId } from '../core/BitChatPacket';
import { encodeDiscovery, decodeDiscovery, safeDecodeDiscovery } from '../DiscoveryPacketCodec';

describe('DiscoveryPayloadCodec', () => {
  it('round trip preserves nodeId', () => {
    const nodeId = '0x0000000000000042';
    const payload = encodeDiscovery(nodeId);
    expect(payload.length).toBe(DISCOVERY_PAYLOAD_SIZE);
    const decoded = decodeDiscovery(payload);
    expect(decoded).toBe(nodeId);
  });

  it('version byte is correct', () => {
    const payload = encodeDiscovery('0x0000000000000001');
    expect(payload[8]).toBe(DISCOVERY_PROTOCOL_VERSION);
  });

  it('payload is exactly 9 bytes', () => {
    const payload = encodeDiscovery('0x0000000000000001');
    expect(payload.length).toBe(9);
  });

  it('max nodeId round trip', () => {
    const maxId = '0xffffffffffffffff';
    const decoded = decodeDiscovery(encodeDiscovery(maxId));
    expect(decoded).toBe(maxId);
  });

  it('min nodeId round trip', () => {
    const minId = '0x0000000000000000';
    const decoded = decodeDiscovery(encodeDiscovery(minId));
    expect(decoded).toBe(minId);
  });

  it('rejects wrong length', () => {
    expect(() => decodeDiscovery(new Uint8Array(5))).toThrow();
    expect(() => decodeDiscovery(new Uint8Array(20))).toThrow();
  });

  it('rejects invalid version', () => {
    const payload = encodeDiscovery('0x0000000000000001');
    payload[8] = 0x99;
    expect(() => decodeDiscovery(payload)).toThrow();
  });

  it('safeDecodeDiscovery returns null on bad payload', () => {
    expect(safeDecodeDiscovery(new Uint8Array(3))).toBeNull();
    expect(safeDecodeDiscovery(new Uint8Array(0))).toBeNull();
  });

  it('safeDecodeDiscovery returns valid nodeId on good data', () => {
    const nodeId = '0x0000000000000042';
    expect(safeDecodeDiscovery(encodeDiscovery(nodeId))).toBe(nodeId);
  });

  it('encodeDiscovery rejects invalid nodeId', () => {
    expect(() => encodeDiscovery('bad' as NodeId)).toThrow();
  });

  it('large nodeId round trip', () => {
    const nodeId = '0x1234567890abcdef';
    const decoded = decodeDiscovery(encodeDiscovery(nodeId));
    expect(decoded).toBe(nodeId);
  });
});
