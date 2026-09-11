/**
 * MVP Hardening — originate honesty + ANNOUNCE handshake tests
 *
 * Covers:
 * - RelayEngine.originate() returns the actual forwarded-peer count
 *   (0 when the registry is empty or all sends fail, ≥1 on success)
 * - BitChatBLEAdapter.originate() propagates the forwarded count
 * - sendToPeer throws on missing BLE mapping (counted as not-forwarded)
 * - Incoming ANNOUNCE triggers the onAnnounceReceived handshake hook
 *   exactly once for a NEW peer (idempotent for duplicates)
 */

import { RelayEngine, SendToPeerFn, DeliverFn } from '../mesh/RelayEngine';
import { MeshRouter } from '../mesh/MeshRouter';
import { PeerRegistry } from '../peer/PeerRegistry';
import { DedupCache } from '../mesh/DedupCache';
import {
  PROTOCOL_VERSION,
  PACKET_TYPE_DATA,
  PACKET_TYPE_ANNOUNCE,
  DEFAULT_TTL,
  FLAGS_NONE,
  NODE_ID_BROADCAST,
  HEADER_SIZE as BITCHAT_HEADER_SIZE,
} from '../core/BitChatConstants';
import { encodeAnnounce } from '../AnnounceCodec';
import { BitChatBLEAdapter, BleSendFn, LocalDeliverFn } from '../BitChatBLEAdapter';
import { normalizeNodeId } from '../core/BitChatPacket';
import type { BitChatPacket, NodeId, PacketId } from '../core/BitChatTypes';

function makePacketId(n: number): PacketId {
  return normalizeNodeId(BigInt(n));
}

function makePacket(overrides?: Partial<BitChatPacket>): BitChatPacket {
  return {
    version: PROTOCOL_VERSION,
    packetType: PACKET_TYPE_DATA,
    ttl: DEFAULT_TTL,
    sourceNodeId: '0x00000000000000AA',
    destinationNodeId: NODE_ID_BROADCAST,
    packetId: makePacketId(1),
    flags: FLAGS_NONE,
    payload: new Uint8Array([0xDE, 0xAD]),
    ...overrides,
  };
}

// ── RelayEngine.originate() forwarded-count ──────────────────────

describe('RelayEngine originate forwarded count', () => {
  function createContext(localNodeId: string = '0x0000000000000000') {
    const registry = new PeerRegistry(60_000, () => 1000);
    const dedupCache = new DedupCache(256, 60_000, () => 1000);
    const router = new MeshRouter(localNodeId, registry);
    const sendToPeer: SendToPeerFn = async () => {};
    const deliver: DeliverFn = () => {};
    const engine = new RelayEngine({ localNodeId, router, dedupCache, sendToPeer, deliver });
    return { registry, engine };
  }

  it('empty registry → originate resolves with 0 (not silent success)', async () => {
    const ctx = createContext();
    const pkt = makePacket({ sourceNodeId: '0x0000000000000000' });
    const forwarded = await ctx.engine.originate(pkt);
    expect(forwarded).toBe(0);
  });

  it('one valid peer → originate resolves with 1', async () => {
    const ctx = createContext();
    ctx.registry.markConnected('0x0000000000000001');
    const pkt = makePacket({ sourceNodeId: '0x0000000000000000' });
    const forwarded = await ctx.engine.originate(pkt);
    expect(forwarded).toBe(1);
  });

  it('two connected peers → originate resolves with 2', async () => {
    const ctx = createContext();
    ctx.registry.markConnected('0x0000000000000001');
    ctx.registry.markConnected('0x0000000000000002');
    const pkt = makePacket({ sourceNodeId: '0x0000000000000000' });
    const forwarded = await ctx.engine.originate(pkt);
    expect(forwarded).toBe(2);
  });

  it('all sends rejected → forwarded count is 0', async () => {
    const registry = new PeerRegistry(60_000, () => 1000);
    const dedupCache = new DedupCache(256, 60_000, () => 1000);
    const router = new MeshRouter('0x0000000000000000', registry);
    const sendToPeer: SendToPeerFn = async () => {
      throw new Error('BLE write failed');
    };
    const engine = new RelayEngine({
      localNodeId: '0x0000000000000000',
      router,
      dedupCache,
      sendToPeer,
      deliver: () => {},
    });
    registry.markConnected('0x0000000000000001');

    const pkt = makePacket({ sourceNodeId: '0x0000000000000000' });
    const forwarded = await engine.originate(pkt);
    expect(forwarded).toBe(0);
  });

  it('mixed success/failure counts only successful peers', async () => {
    const registry = new PeerRegistry(60_000, () => 1000);
    const dedupCache = new DedupCache(256, 60_000, () => 1000);
    const router = new MeshRouter('0x0000000000000000', registry);
    const sendToPeer: SendToPeerFn = async (peerId) => {
      if (peerId === '0x0000000000000002') throw new Error('dead link');
    };
    const engine = new RelayEngine({
      localNodeId: '0x0000000000000000',
      router,
      dedupCache,
      sendToPeer,
      deliver: () => {},
    });
    registry.markConnected('0x0000000000000001');
    registry.markConnected('0x0000000000000002');
    registry.markConnected('0x0000000000000003');

    const pkt = makePacket({ sourceNodeId: '0x0000000000000000' });
    const forwarded = await engine.originate(pkt);
    expect(forwarded).toBe(2);
  });

  it('zero TTL → forwarded count is 0', async () => {
    const ctx = createContext();
    ctx.registry.markConnected('0x0000000000000001');
    const pkt = makePacket({ sourceNodeId: '0x0000000000000000', ttl: 0 });
    const forwarded = await ctx.engine.originate(pkt);
    expect(forwarded).toBe(0);
  });
});

// ── BitChatBLEAdapter originate + sendToPeer honesty ─────────────

describe('BitChatBLEAdapter originate honesty', () => {
  interface SimNode {
    adapter: BitChatBLEAdapter;
    localNodeId: NodeId;
    bleSends: Map<string, Uint8Array[]>;
  }

  function createSimNode(nodeId: string, failFor?: string): SimNode {
    const bleSends = new Map<string, Uint8Array[]>();
    const bleSendFn: BleSendFn = async (peerBleId, payload) => {
      if (peerBleId === failFor) throw new Error('native send failed');
      if (!bleSends.has(peerBleId)) bleSends.set(peerBleId, []);
      bleSends.get(peerBleId)!.push(new Uint8Array(payload));
    };
    const adapter = new BitChatBLEAdapter({
      localNodeId: nodeId,
      bleSend: bleSendFn,
      onLocalDeliver: () => {},
    });
    return { adapter, localNodeId: normalizeNodeId(nodeId), bleSends };
  }

  it('originate to a registered peer returns 1 and transmits', async () => {
    const a = createSimNode('0x00000000000000AA');
    const b = createSimNode('0x00000000000000BB');
    a.adapter.registerPeer('ble_B', b.localNodeId);

    const forwarded = await a.adapter.originate(
      new Uint8Array([0x02, 0x01, 0x00, 0x01]),
      makePacketId(100),
    );
    expect(forwarded).toBe(1);
    expect(a.bleSends.get('ble_B')!.length).toBe(1);
  });

  it('originate with empty registry returns 0 and transmits nothing', async () => {
    const a = createSimNode('0x00000000000000AA');
    const forwarded = await a.adapter.originate(new Uint8Array([0x01]), makePacketId(101));
    expect(forwarded).toBe(0);
  });

  it('originate where the only peer send throws returns 0', async () => {
    const a = createSimNode('0x00000000000000AA', 'ble_B');
    const b = createSimNode('0x00000000000000BB');
    a.adapter.registerPeer('ble_B', b.localNodeId);

    const forwarded = await a.adapter.originate(new Uint8Array([0x01]), makePacketId(102));
    expect(forwarded).toBe(0);
  });

  it('originate with one dead and one live peer returns 1 and still delivers to the live peer', async () => {
    const a = createSimNode('0x00000000000000AA', 'ble_dead');
    const b = createSimNode('0x00000000000000BB');
    const c = createSimNode('0x00000000000000CC');
    a.adapter.registerPeer('ble_dead', b.localNodeId);
    a.adapter.registerPeer('ble_live', c.localNodeId);

    const forwarded = await a.adapter.originate(new Uint8Array([0x01]), makePacketId(103));
    expect(forwarded).toBe(1);
    expect(a.bleSends.get('ble_live')!.length).toBe(1);
    expect(a.bleSends.has('ble_dead')).toBe(false);
  });
});

// ── ANNOUNCE handshake ───────────────────────────────────────────

describe('BitChatBLEAdapter ANNOUNCE handshake', () => {
  function makeAnnouncePacketBytes(localNodeId: NodeId): Uint8Array {
    const payload = encodeAnnounce(localNodeId);
    const packet: BitChatPacket = {
      version: PROTOCOL_VERSION,
      packetType: PACKET_TYPE_ANNOUNCE,
      ttl: DEFAULT_TTL,
      sourceNodeId: localNodeId,
      destinationNodeId: NODE_ID_BROADCAST,
      packetId: makePacketId(1),
      flags: FLAGS_NONE,
      payload,
    };
    // Encode via the adapter's own creation path is asymmetric; build the
    // envelope manually with the codec exported from core.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { encode } = require('../core/BitChatPacketCodec');
    return encode(packet);
  }

  it('valid ANNOUNCE registers the peer and fires onAnnounceReceived once', async () => {
    const announced: { blePeerId: string; nodeId: NodeId }[] = [];
    const a = new BitChatBLEAdapter({
      localNodeId: '0x00000000000000AA',
      bleSend: async () => {},
      onLocalDeliver: () => {},
      onAnnounceReceived: (blePeerId, nodeId) => {
        announced.push({ blePeerId, nodeId });
      },
    });

    const bNodeId = normalizeNodeId('0x00000000000000BB');
    const raw = makeAnnouncePacketBytes(bNodeId);
    const kind = await a.receive(raw, 'ble_B');

    expect(kind).toBe('announce');
    expect(a.getNodeIdForBlePeer('ble_B')).toBe(bNodeId);
    expect(a.isDirectPeerReady('ble_B')).toBe(true);
    expect(announced).toEqual([{ blePeerId: 'ble_B', nodeId: bNodeId }]);
  });

  it('duplicate ANNOUNCE from a known peer does NOT re-fire onAnnounceReceived', async () => {
    let fireCount = 0;
    const a = new BitChatBLEAdapter({
      localNodeId: '0x00000000000000AA',
      bleSend: async () => {},
      onLocalDeliver: () => {},
      onAnnounceReceived: () => {
        fireCount++;
      },
    });

    const bNodeId = normalizeNodeId('0x00000000000000BB');
    const raw = makeAnnouncePacketBytes(bNodeId);

    await a.receive(raw, 'ble_B');
    await a.receive(raw, 'ble_B');
    await a.receive(raw, 'ble_B');

    expect(fireCount).toBe(1);
    // Registration stays correct and idempotent.
    expect(a.getNodeIdForBlePeer('ble_B')).toBe(bNodeId);
  });

  it('re-ANNOUNCE after unregisterPeer re-fires the hook (reconnect healing)', async () => {
    let fireCount = 0;
    const a = new BitChatBLEAdapter({
      localNodeId: '0x00000000000000AA',
      bleSend: async () => {},
      onLocalDeliver: () => {},
      onAnnounceReceived: () => {
        fireCount++;
      },
    });

    const bNodeId = normalizeNodeId('0x00000000000000BB');
    const raw = makeAnnouncePacketBytes(bNodeId);

    await a.receive(raw, 'ble_B');
    a.unregisterPeer('ble_B');
    expect(a.getNodeIdForBlePeer('ble_B')).toBeUndefined();
    expect(a.isDirectPeerReady('ble_B')).toBe(false);

    // Simulates a reconnect: same peer announces again → hook fires again.
    await a.receive(raw, 'ble_B');
    expect(fireCount).toBe(2);
    expect(a.getNodeIdForBlePeer('ble_B')).toBe(bNodeId);
    expect(a.isDirectPeerReady('ble_B')).toBe(true);
  });

  it('re-ANNOUNCE replaces stale BLE and NodeId indexes bijectively', () => {
    const a = new BitChatBLEAdapter({
      localNodeId: '0x00000000000000AA',
      bleSend: async () => {},
      onLocalDeliver: () => {},
    });
    const oldNode = normalizeNodeId('0x00000000000000BB');
    const newNode = normalizeNodeId('0x00000000000000CC');

    a.registerPeer('ble_B', oldNode);
    a.registerPeer('ble_B', newNode);
    expect(a.getNodeIdForBlePeer('ble_B')).toBe(newNode);
    expect(a.getBlePeerForNodeId(oldNode)).toBeUndefined();
    expect(a.getBlePeerForNodeId(newNode)).toBe('ble_B');

    // A node moving to a new native connection key also removes the old
    // direct route instead of leaving a stale send target behind.
    a.registerPeer('ble_B_reconnected', newNode);
    expect(a.getNodeIdForBlePeer('ble_B')).toBeUndefined();
    expect(a.getBlePeerForNodeId(newNode)).toBe('ble_B_reconnected');
  });

  it('onAnnounceReceived throwing never breaks packet processing', async () => {
    const a = new BitChatBLEAdapter({
      localNodeId: '0x00000000000000AA',
      bleSend: async () => {},
      onLocalDeliver: () => {},
      onAnnounceReceived: () => {
        throw new Error('hook bug');
      },
    });

    const bNodeId = normalizeNodeId('0x00000000000000BB');
    const raw = makeAnnouncePacketBytes(bNodeId);
    const kind = await a.receive(raw, 'ble_B');
    expect(kind).toBe('announce');
    expect(a.getNodeIdForBlePeer('ble_B')).toBe(bNodeId);
  });

  it('malformed ANNOUNCE payload does not register or fire the hook', async () => {
    let fired = false;
    const a = new BitChatBLEAdapter({
      localNodeId: '0x00000000000000AA',
      bleSend: async () => {},
      onLocalDeliver: () => {},
      onAnnounceReceived: () => {
        fired = true;
      },
    });

    // Envelope valid but payload shorter than the 9-byte ANNOUNCE minimum.
    const packet: BitChatPacket = {
      version: PROTOCOL_VERSION,
      packetType: PACKET_TYPE_ANNOUNCE,
      ttl: DEFAULT_TTL,
      sourceNodeId: normalizeNodeId('0x00000000000000BB'),
      destinationNodeId: NODE_ID_BROADCAST,
      packetId: makePacketId(2),
      flags: FLAGS_NONE,
      payload: new Uint8Array(4),
    };
    const { encode } = require('../core/BitChatPacketCodec');
    const raw = encode(packet);

    const kind = await a.receive(raw, 'ble_B');
    expect(kind).toBe('announce');
    expect(a.getNodeIdForBlePeer('ble_B')).toBeUndefined();
    expect(fired).toBe(false);
  });

  it('BITCHAT header size assumption holds for mesh frame budget (28 bytes)', () => {
    // The mesh fragmentation budget in useBLEVoiceMode is derived as
    // V6B_MAX_PAYLOAD_SIZE − BITCHAT_HEADER_SIZE = 499 − 28 = 471.
    expect(BITCHAT_HEADER_SIZE).toBe(28);
  });
});
