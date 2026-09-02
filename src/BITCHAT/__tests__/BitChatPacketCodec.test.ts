/**
 * V9A BitChat Packet Codec — Tests
 */

import {
  HEADER_SIZE,
  PROTOCOL_VERSION,
  PACKET_TYPE_DATA,
  PACKET_TYPE_ANNOUNCE,
  FLAGS_NONE,
  DEFAULT_TTL,
  MAX_TTL,
  ANNOUNCE_PAYLOAD_SIZE,
  ANNOUNCE_PROTOCOL_VERSION,
} from '../core/BitChatConstants';
import type { BitChatPacket, NodeId, PacketId } from '../core/BitChatTypes';
import {
  normalizeNodeId,
  normalizePacketId,
  isValidNodeId,
  isValidPacketId,
} from '../core/BitChatPacket';
import { encode, decode, safeDecode } from '../core/BitChatPacketCodec';
import { encodeAnnounce, decodeAnnounce, safeDecodeAnnounce } from '../AnnounceCodec';

// ══════════════════════════════════════════════════════════════════
// NodeId / PacketId Helpers
// ══════════════════════════════════════════════════════════════════

describe('NodeId / PacketId Helpers', () => {
  it('normalizes bigint to hex string', () => {
    expect(normalizeNodeId(BigInt(0))).toBe('0x0000000000000000');
    expect(normalizeNodeId(BigInt(1))).toBe('0x0000000000000001');
    expect(normalizeNodeId(BigInt(255))).toBe('0x00000000000000ff');
  });

  it('normalizes number to hex string', () => {
    expect(normalizeNodeId(0)).toBe('0x0000000000000000');
    expect(normalizeNodeId(42)).toBe('0x000000000000002a');
  });

  it('normalizes hex string input', () => {
    expect(normalizeNodeId('0xFF')).toBe('0x00000000000000ff');
    expect(normalizeNodeId('0xABCD')).toBe('0x000000000000abcd');
  });

  it('normalizes decimal string input', () => {
    expect(normalizeNodeId('100')).toBe('0x0000000000000064');
  });

  it('formats as fixed-width 16 hex digits', () => {
    const id = normalizeNodeId(BigInt('18446744073709551615')); // max UInt64
    expect(id).toBe('0xffffffffffffffff');
    expect(id.length).toBe(18); // "0x" + 16 digits
  });

  it('zero is valid', () => {
    expect(normalizeNodeId(0)).toBe('0x0000000000000000');
    expect(isValidNodeId('0x0000000000000000')).toBe(true);
  });

  it('max UInt64 is valid', () => {
    const max = normalizeNodeId(BigInt('18446744073709551615'));
    expect(max).toBe('0xffffffffffffffff');
    expect(isValidNodeId(max)).toBe(true);
  });

  it('rejects overflow', () => {
    expect(() => normalizeNodeId(BigInt('18446744073709551616'))).toThrow();
  });

  it('rejects negative', () => {
    expect(() => normalizeNodeId(-1)).toThrow();
    expect(() => normalizeNodeId(BigInt(-1))).toThrow();
  });

  it('rejects malformed hex', () => {
    expect(isValidNodeId('not-a-hex')).toBe(false);
    expect(isValidNodeId('0xGG')).toBe(false);
    expect(isValidNodeId('0x123')).toBe(false); // too short
  });

  it('rejects non-finite numbers', () => {
    expect(() => normalizeNodeId(NaN)).toThrow();
    expect(() => normalizeNodeId(Infinity)).toThrow();
  });

  it('rejects floating point', () => {
    expect(() => normalizeNodeId(1.5)).toThrow();
  });

  it('isValidNodeId and isValidPacketId work identically', () => {
    expect(isValidNodeId('0x0000000000000000')).toBe(true);
    expect(isValidPacketId('0x0000000000000000')).toBe(true);
    expect(isValidNodeId('bad')).toBe(false);
    expect(isValidPacketId('bad')).toBe(false);
  });

  it('lowercase conversion', () => {
    expect(normalizeNodeId('0xABCD1234')).toBe('0x00000000abcd1234');
  });
});

// ══════════════════════════════════════════════════════════════════
// BitChatPacketCodec
// ══════════════════════════════════════════════════════════════════

describe('BitChatPacketCodec', () => {
  function makePacket(overrides?: Partial<BitChatPacket>): BitChatPacket {
    return {
      version: PROTOCOL_VERSION,
      packetType: PACKET_TYPE_DATA,
      ttl: DEFAULT_TTL,
      sourceNodeId: '0x0000000000000001',
      packetId: '0x0000000000000042',
      flags: FLAGS_NONE,
      payload: new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]),
      ...overrides,
    };
  }

  // ── Round Trip ─────────────────────────────────────────────────

  it('DATA round trip preserves all fields', () => {
    const pkt = makePacket();
    const bytes = encode(pkt);
    const decoded = decode(bytes);

    expect(decoded.version).toBe(pkt.version);
    expect(decoded.packetType).toBe(pkt.packetType);
    expect(decoded.ttl).toBe(pkt.ttl);
    expect(decoded.sourceNodeId).toBe(pkt.sourceNodeId);
    expect(decoded.packetId).toBe(pkt.packetId);
    expect(decoded.flags).toBe(pkt.flags);
    expect(decoded.payload).toEqual(pkt.payload);
  });

  it('ANNOUNCE round trip preserves all fields', () => {
    const pkt = makePacket({ packetType: PACKET_TYPE_ANNOUNCE, payload: new Uint8Array(9).fill(0x01) });
    const bytes = encode(pkt);
    const decoded = decode(bytes);

    expect(decoded.packetType).toBe(PACKET_TYPE_ANNOUNCE);
    expect(decoded.payload.length).toBe(9);
  });

  it('empty payload round trip', () => {
    const pkt = makePacket({ payload: new Uint8Array(0) });
    const bytes = encode(pkt);
    expect(bytes.length).toBe(HEADER_SIZE);

    const decoded = decode(bytes);
    expect(decoded.payload.length).toBe(0);
  });

  it('arbitrary binary payload round trip', () => {
    const payload = new Uint8Array(256);
    for (let i = 0; i < 256; i++) payload[i] = i;
    const pkt = makePacket({ payload });
    const bytes = encode(pkt);
    const decoded = decode(bytes);
    expect(decoded.payload).toEqual(payload);
  });

  it('min TTL (0) round trip', () => {
    const pkt = makePacket({ ttl: 0 });
    const decoded = decode(encode(pkt));
    expect(decoded.ttl).toBe(0);
  });

  it('max TTL (255) round trip', () => {
    const pkt = makePacket({ ttl: 255 });
    const decoded = decode(encode(pkt));
    expect(decoded.ttl).toBe(255);
  });

  it('total encoded size = HEADER_SIZE + payload.length', () => {
    const pkt = makePacket({ payload: new Uint8Array(100) });
    const bytes = encode(pkt);
    expect(bytes.length).toBe(HEADER_SIZE + 100);
  });

  // ── Validation ─────────────────────────────────────────────────

  it('rejects invalid version', () => {
    const pkt = makePacket({ version: 0x99 });
    expect(() => encode(pkt)).toThrow();
  });

  it('rejects unknown packet type', () => {
    const pkt = makePacket({ packetType: 0xFF });
    expect(() => encode(pkt)).toThrow();
  });

  it('rejects negative TTL', () => {
    const pkt = makePacket({ ttl: -1 });
    expect(() => encode(pkt)).toThrow();
  });

  it('rejects TTL > 255', () => {
    const pkt = makePacket({ ttl: 256 });
    expect(() => encode(pkt)).toThrow();
  });

  it('rejects non-integer TTL', () => {
    const pkt = makePacket({ ttl: 1.5 });
    expect(() => encode(pkt)).toThrow();
  });

  it('rejects invalid sourceNodeId', () => {
    const pkt = makePacket({ sourceNodeId: 'bad' as NodeId });
    expect(() => encode(pkt)).toThrow();
  });

  it('rejects invalid packetId', () => {
    const pkt = makePacket({ packetId: 'bad' as PacketId });
    expect(() => encode(pkt)).toThrow();
  });

  it('rejects truncated header', () => {
    expect(() => decode(new Uint8Array(10))).toThrow();
  });

  it('rejects unsupported version on decode', () => {
    const pkt = makePacket();
    const bytes = encode(pkt);
    bytes[0] = 0x99;
    expect(() => decode(bytes)).toThrow();
  });

  it('rejects unknown packet type on decode', () => {
    const pkt = makePacket();
    const bytes = encode(pkt);
    bytes[1] = 0xFF;
    expect(() => decode(bytes)).toThrow();
  });

  it('safeDecode returns null on malformed data', () => {
    expect(safeDecode(new Uint8Array(5))).toBeNull();
    expect(safeDecode(new Uint8Array(0))).toBeNull();
  });

  it('safeDecode returns valid packet on good data', () => {
    const pkt = makePacket();
    expect(safeDecode(encode(pkt))).not.toBeNull();
  });

  it('field preservation: all UInt64 values are exact', () => {
    const pkt = makePacket({
      sourceNodeId: '0x1234567890abcdef',
      packetId: '0xfedcba0987654321',
    });
    const decoded = decode(encode(pkt));
    expect(decoded.sourceNodeId).toBe('0x1234567890abcdef');
    expect(decoded.packetId).toBe('0xfedcba0987654321');
  });
});

// ══════════════════════════════════════════════════════════════════
// ANNOUNCE Payload Codec
// ══════════════════════════════════════════════════════════════════

describe('ANNOUNCE Payload Codec', () => {
  it('round trip', () => {
    const nodeId = '0x0000000000000042';
    const payload = encodeAnnounce(nodeId);
    expect(payload.length).toBe(ANNOUNCE_PAYLOAD_SIZE);
    const decoded = decodeAnnounce(payload);
    expect(decoded).toBe(nodeId);
  });

  it('version byte is correct', () => {
    const payload = encodeAnnounce('0x0000000000000001');
    expect(payload[8]).toBe(ANNOUNCE_PROTOCOL_VERSION);
  });

  it('rejects wrong length', () => {
    expect(() => decodeAnnounce(new Uint8Array(5))).toThrow();
    expect(() => decodeAnnounce(new Uint8Array(20))).toThrow();
  });

  it('rejects invalid version', () => {
    const payload = encodeAnnounce('0x0000000000000001');
    payload[8] = 0x99;
    expect(() => decodeAnnounce(payload)).toThrow();
  });

  it('max nodeId round trip', () => {
    const maxId = '0xffffffffffffffff';
    const decoded = decodeAnnounce(encodeAnnounce(maxId));
    expect(decoded).toBe(maxId);
  });

  it('min nodeId round trip', () => {
    const minId = '0x0000000000000000';
    const decoded = decodeAnnounce(encodeAnnounce(minId));
    expect(decoded).toBe(minId);
  });

  it('safeDecodeAnnounce returns null on bad payload', () => {
    expect(safeDecodeAnnounce(new Uint8Array(3))).toBeNull();
  });

  it('encodeAnnounce rejects invalid nodeId', () => {
    expect(() => encodeAnnounce('bad' as NodeId)).toThrow();
  });
});
