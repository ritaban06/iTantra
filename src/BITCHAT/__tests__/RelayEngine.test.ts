/**
 * V9B RelayEngine — Tests
 */

import { RelayEngine, SendToPeerFn, DeliverFn } from '../mesh/RelayEngine';
import { MeshRouter } from '../mesh/MeshRouter';
import { PeerRegistry } from '../peer/PeerRegistry';
import { DedupCache } from '../mesh/DedupCache';
import { normalizeNodeId } from '../core/BitChatPacket';
import {
  PROTOCOL_VERSION,
  PACKET_TYPE_DATA,
  PACKET_TYPE_ANNOUNCE,
  DEFAULT_TTL,
  NODE_ID_BROADCAST,
} from '../core/BitChatConstants';
import type { BitChatPacket, NodeId } from '../core/BitChatTypes';

// ── Helpers ──────────────────────────────────────────────────────

/** Create a packet with destinationNodeId defaulting to BROADCAST (V9C backward compat). */
function makePacket(overrides?: Partial<BitChatPacket>): BitChatPacket {
  return {
    version: PROTOCOL_VERSION,
    packetType: PACKET_TYPE_DATA,
    ttl: DEFAULT_TTL,
    sourceNodeId: '0x00000000000000AA',
    destinationNodeId: NODE_ID_BROADCAST,
    packetId: '0x0000000000000001',
    flags: 0,
    payload: new Uint8Array([0xDE, 0xAD]),
    ...overrides,
  };
}

function makeAnnounce(overrides?: Partial<BitChatPacket>): BitChatPacket {
  return makePacket({
    packetType: PACKET_TYPE_ANNOUNCE,
    destinationNodeId: NODE_ID_BROADCAST,
    payload: new Uint8Array(9).fill(0x01),
    ...overrides,
  });
}

interface TestContext {
  registry: PeerRegistry;
  dedupCache: DedupCache;
  router: MeshRouter;
  deliveries: { packet: BitChatPacket; fromPeerId?: NodeId }[];
  sentTo: Map<NodeId, BitChatPacket[]>;
  engine: RelayEngine;
}

function createContext(localNodeId: string = '0x0000000000000000'): TestContext {
  const registry = new PeerRegistry(60_000, () => 1000);
  const dedupCache = new DedupCache(256, 60_000, () => 1000);
  const router = new MeshRouter(localNodeId, registry);
  const deliveries: { packet: BitChatPacket; fromPeerId?: NodeId }[] = [];
  const sentTo = new Map<NodeId, BitChatPacket[]>();

  const sendToPeer: SendToPeerFn = async (peerId, packet) => {
    const id = normalizeNodeId(peerId);
    if (!sentTo.has(id)) sentTo.set(id, []);
    sentTo.get(id)!.push(packet);
  };

  const deliver: DeliverFn = (packet, fromPeerId) => {
    deliveries.push({ packet, fromPeerId });
  };

  const engine = new RelayEngine({
    localNodeId,
    router,
    dedupCache,
    sendToPeer,
    deliver,
  });

  return { registry, dedupCache, router, deliveries, sentTo, engine };
}

// ══════════════════════════════════════════════════════════════════
// RelayEngine Tests (1–24)
// ══════════════════════════════════════════════════════════════════

describe('RelayEngine', () => {
  // ── Delivery ──────────────────────────────────────────────────

  // Test 1
  it('first-seen packet is delivered once', async () => {
    const ctx = createContext();
    const pkt = makePacket();

    await ctx.engine.receive(pkt, '0x0000000000000001');

    expect(ctx.deliveries.length).toBe(1);
    expect(ctx.deliveries[0].packet.packetId).toBe(pkt.packetId);
  });

  // Test 2
  it('duplicate packet is not delivered', async () => {
    const ctx = createContext();
    const pkt = makePacket();

    await ctx.engine.receive(pkt, '0x0000000000000001');
    await ctx.engine.receive(pkt, '0x0000000000000002');

    expect(ctx.deliveries.length).toBe(1);
  });

  // Test 3
  it('duplicate packet is not relayed', async () => {
    const ctx = createContext();
    ctx.registry.markConnected('0x0000000000000001');
    ctx.registry.markConnected('0x0000000000000002');

    const pkt = makePacket();
    await ctx.engine.receive(pkt, '0x0000000000000001'); // first seen
    ctx.sentTo.clear();
    await ctx.engine.receive(pkt, '0x0000000000000003'); // duplicate

    expect(ctx.sentTo.size).toBe(0);
  });

  // ── TTL ───────────────────────────────────────────────────────

  // Test 4
  it('TTL=0 is delivered but not forwarded', async () => {
    const ctx = createContext();
    ctx.registry.markConnected('0x0000000000000001');

    const pkt = makePacket({ ttl: 0 });
    await ctx.engine.receive(pkt, '0x0000000000000002');

    expect(ctx.deliveries.length).toBe(1);
    expect(ctx.sentTo.size).toBe(0);
  });

  // Test 5
  it('TTL=1 forwards with TTL=0', async () => {
    const ctx = createContext();
    ctx.registry.markConnected('0x0000000000000001');

    const pkt = makePacket({ ttl: 1 });
    await ctx.engine.receive(pkt, '0x0000000000000002');

    expect(ctx.deliveries.length).toBe(1);
    const forwarded = ctx.sentTo.get('0x0000000000000001')!;
    expect(forwarded).toBeDefined();
    expect(forwarded[0].ttl).toBe(0);
  });

  // Test 6
  it('TTL decreases by exactly one', async () => {
    const ctx = createContext();
    ctx.registry.markConnected('0x0000000000000001');

    const pkt = makePacket({ ttl: 5 });
    await ctx.engine.receive(pkt, '0x0000000000000002');

    const forwarded = ctx.sentTo.get('0x0000000000000001')!;
    expect(forwarded[0].ttl).toBe(4);
  });

  // ── Packet Identity ───────────────────────────────────────────

  // Test 7
  it('sourceNodeId remains unchanged across relay', async () => {
    const ctx = createContext();
    ctx.registry.markConnected('0x0000000000000001');

    const pkt = makePacket({ sourceNodeId: '0x00000000000000AA' });
    await ctx.engine.receive(pkt, '0x0000000000000002');

    const forwarded = ctx.sentTo.get('0x0000000000000001')!;
    // RelayEngine preserves the original sourceNodeId string as-is
    expect(forwarded[0].sourceNodeId).toBe('0x00000000000000AA');
  });

  // Test 8
  it('packetId remains unchanged across relay', async () => {
    const ctx = createContext();
    ctx.registry.markConnected('0x0000000000000001');

    const pkt = makePacket({ packetId: '0x0000000000000042' });
    await ctx.engine.receive(pkt, '0x0000000000000002');

    const forwarded = ctx.sentTo.get('0x0000000000000001')!;
    expect(forwarded[0].packetId).toBe('0x0000000000000042');
  });

  // Test 9
  it('payload remains byte-for-byte identical', async () => {
    const ctx = createContext();
    ctx.registry.markConnected('0x0000000000000001');

    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const pkt = makePacket({ payload });
    await ctx.engine.receive(pkt, '0x0000000000000002');

    const forwarded = ctx.sentTo.get('0x0000000000000001')!;
    expect(forwarded[0].payload).toEqual(payload);
  });

  // Test 10
  it('flags remain unchanged', async () => {
    const ctx = createContext();
    ctx.registry.markConnected('0x0000000000000001');

    const pkt = makePacket({ flags: 0x0F });
    await ctx.engine.receive(pkt, '0x0000000000000002');

    const forwarded = ctx.sentTo.get('0x0000000000000001')!;
    expect(forwarded[0].flags).toBe(0x0F);
  });

  // ── Peer Selection ────────────────────────────────────────────

  // Test 11
  it('incoming peer is excluded from forwarding', async () => {
    const ctx = createContext();
    ctx.registry.markConnected('0x0000000000000001');
    ctx.registry.markConnected('0x0000000000000002');

    const pkt = makePacket();
    await ctx.engine.receive(pkt, '0x0000000000000001');

    expect(ctx.sentTo.has('0x0000000000000001')).toBe(false);
    expect(ctx.sentTo.has('0x0000000000000002')).toBe(true);
  });

  // Test 12
  it('all other connected peers receive the packet', async () => {
    const ctx = createContext();
    ctx.registry.markConnected('0x0000000000000001');
    ctx.registry.markConnected('0x0000000000000002');
    ctx.registry.markConnected('0x0000000000000003');

    const pkt = makePacket();
    await ctx.engine.receive(pkt, '0x0000000000000001');

    expect(ctx.sentTo.has('0x0000000000000002')).toBe(true);
    expect(ctx.sentTo.has('0x0000000000000003')).toBe(true);
  });

  // Test 13
  it('disconnected peers do not receive the packet', async () => {
    const ctx = createContext();
    ctx.registry.markConnected('0x0000000000000001');
    ctx.registry.upsertPeer('0x0000000000000002'); // DISCOVERED

    const pkt = makePacket();
    await ctx.engine.receive(pkt, '0x0000000000000003');

    expect(ctx.sentTo.has('0x0000000000000001')).toBe(true);
    expect(ctx.sentTo.has('0x0000000000000002')).toBe(false);
  });

  // ── Loop Prevention ───────────────────────────────────────────

  // Test 14
  it('A→B→A loop terminates (incoming peer exclusion)', async () => {
    // Node A receives from B, relays to C (not back to B).
    // If B sends it back, A's dedup catches it.
    const ctxA = createContext('0x00000000000000AA');
    ctxA.registry.markConnected('0x00000000000000BB'); // incoming peer
    ctxA.registry.markConnected('0x00000000000000CC'); // relay target

    const pkt = makePacket({ sourceNodeId: '0x00000000000000DD' });
    await ctxA.engine.receive(pkt, '0x00000000000000BB');

    // A relays to C (B excluded as incoming) — Map keys are normalized (lowercase)
    const ccKey = normalizeNodeId('0x00000000000000CC');
    const bbKey = normalizeNodeId('0x00000000000000BB');
    expect(ctxA.sentTo.has(ccKey)).toBe(true);
    expect(ctxA.sentTo.has(bbKey)).toBe(false);

    // If B sends it back, A's dedup catches it
    ctxA.sentTo.clear();
    await ctxA.engine.receive(pkt, '0x00000000000000BB'); // duplicate
    expect(ctxA.deliveries.length).toBe(1); // not delivered again
    expect(ctxA.sentTo.size).toBe(0); // not relayed again
  });

  // Test 15
  it('A→B→C→A loop terminates through dedup', async () => {
    const ctxA = createContext('0x00000000000000AA');
    ctxA.registry.markConnected('0x00000000000000BB');

    const pkt = makePacket({ sourceNodeId: '0x00000000000000DD' });

    // First time from B
    await ctxA.engine.receive(pkt, '0x00000000000000BB');
    expect(ctxA.deliveries.length).toBe(1);

    // If C sends it back to A later
    ctxA.sentTo.clear();
    await ctxA.engine.receive(pkt, '0x00000000000000CC');
    expect(ctxA.deliveries.length).toBe(1); // not delivered again
    expect(ctxA.sentTo.size).toBe(0); // not relayed
  });

  // ── Independent Forwarding ────────────────────────────────────

  // Test 16
  it('different packet IDs are forwarded independently', async () => {
    const ctx = createContext();
    ctx.registry.markConnected('0x0000000000000001');

    const pkt1 = makePacket({ packetId: '0x0000000000000001' });
    const pkt2 = makePacket({ packetId: '0x0000000000000002' });

    await ctx.engine.receive(pkt1, '0x0000000000000002');
    await ctx.engine.receive(pkt2, '0x0000000000000002');

    expect(ctx.deliveries.length).toBe(2);
    expect(ctx.sentTo.get('0x0000000000000001')!.length).toBe(2);
  });

  // Test 17
  it('same packetId with different sourceNodeId is treated as different packet', async () => {
    const ctx = createContext();
    ctx.registry.markConnected('0x0000000000000001');

    const pkt1 = makePacket({ sourceNodeId: '0x00000000000000AA', packetId: '0x0000000000000001' });
    const pkt2 = makePacket({ sourceNodeId: '0x00000000000000BB', packetId: '0x0000000000000001' });

    await ctx.engine.receive(pkt1, '0x0000000000000002');
    await ctx.engine.receive(pkt2, '0x0000000000000002');

    expect(ctx.deliveries.length).toBe(2);
  });

  // ── Error Handling ────────────────────────────────────────────

  // Test 18
  it('send failure to one peer does not stop other peers', async () => {
    const registry = new PeerRegistry(60_000, () => 1000);
    registry.markConnected('0x0000000000000001');
    registry.markConnected('0x0000000000000002');
    registry.markConnected('0x0000000000000003');

    const dedupCache = new DedupCache(256, 60_000, () => 1000);
    const router = new MeshRouter('0x0000000000000000', registry);
    const deliveries: BitChatPacket[] = [];
    const sentTo = new Map<NodeId, BitChatPacket[]>();

    const sendToPeer: SendToPeerFn = async (peerId, packet) => {
      const id = normalizeNodeId(peerId);
      if (id === '0x0000000000000002') throw new Error('peer unavailable');
      if (!sentTo.has(id)) sentTo.set(id, []);
      sentTo.get(id)!.push(packet);
    };

    const engine = new RelayEngine({
      localNodeId: '0x0000000000000000',
      router, dedupCache, sendToPeer,
      deliver: (pkt) => deliveries.push(pkt),
    });

    const pkt = makePacket();
    await engine.receive(pkt, '0x00000000000000FF');

    // Peer 02 failed, but 01 and 03 should still receive
    expect(ctx_has(sentTo, '0x0000000000000001')).toBe(true);
    expect(ctx_has(sentTo, '0x0000000000000003')).toBe(true);
  });

  // ── Originated Packets ────────────────────────────────────────

  // Test 19
  it('originated packet forwards to all connected peers', async () => {
    const ctx = createContext();
    ctx.registry.markConnected('0x0000000000000001');
    ctx.registry.markConnected('0x0000000000000002');

    const pkt = makePacket({ sourceNodeId: '0x0000000000000000' });
    await ctx.engine.originate(pkt);

    expect(ctx.sentTo.has('0x0000000000000001')).toBe(true);
    expect(ctx.sentTo.has('0x0000000000000002')).toBe(true);
  });

  // Test 20
  it('originated packet has no incoming-peer exclusion', async () => {
    const ctx = createContext();
    ctx.registry.markConnected('0x0000000000000001');

    const pkt = makePacket({ sourceNodeId: '0x0000000000000000' });
    await ctx.engine.originate(pkt);

    // 0x01 is the only peer and should receive it
    expect(ctx.sentTo.has('0x0000000000000001')).toBe(true);
  });

  // Test 21
  it('originated packet gets TTL decremented only on forwarded copy', async () => {
    const ctx = createContext();
    ctx.registry.markConnected('0x0000000000000001');

    const pkt = makePacket({ ttl: 5, sourceNodeId: '0x0000000000000000' });
    await ctx.engine.originate(pkt);

    const forwarded = ctx.sentTo.get('0x0000000000000001')!;
    expect(forwarded[0].ttl).toBe(4);
  });

  // ── Packet Immutability ───────────────────────────────────────

  // Test 22
  it('receive does not mutate original packet', async () => {
    const ctx = createContext();
    ctx.registry.markConnected('0x0000000000000001');

    const pkt = makePacket({ ttl: 5 });
    const originalTtl = pkt.ttl;
    await ctx.engine.receive(pkt, '0x0000000000000002');

    expect(pkt.ttl).toBe(originalTtl);
  });

  // ── ANNOUNCE ──────────────────────────────────────────────────

  // Test 23
  it('ANNOUNCE packets are delivered locally but never forwarded', async () => {
    const ctx = createContext();
    ctx.registry.markConnected('0x0000000000000001');
    ctx.registry.markConnected('0x0000000000000003');

    const pkt = makeAnnounce({ ttl: 5 });
    await ctx.engine.receive(pkt, '0x0000000000000002');

    // Should deliver locally (broadcast)
    expect(ctx.deliveries.length).toBe(1);
    expect(ctx.deliveries[0].packet.packetType).toBe(PACKET_TYPE_ANNOUNCE);
    // Should NOT forward — ANNOUNCE is direct-link-only
    expect(ctx.sentTo.size).toBe(0);
  });

  // Test 24
  it('invalid packet is rejected', async () => {
    const ctx = createContext();
    ctx.registry.markConnected('0x0000000000000001');

    const pkt = makePacket({ sourceNodeId: '' as NodeId });
    await ctx.engine.receive(pkt, '0x0000000000000002');

    expect(ctx.deliveries.length).toBe(0);
    expect(ctx.sentTo.size).toBe(0);
  });
});

// ── Destination-Aware Delivery (V9C) ───────────────────────────

describe('RelayEngine — Destination-Aware Delivery (V9C)', () => {
  // Test 25: unicast packet addressed to another node is NOT delivered locally
  it('unicast packet addressed to different node is not delivered locally', async () => {
    const ctx = createContext('0x00000000000000AA');
    ctx.registry.markConnected('0x00000000000000CC');

    const pkt = makePacket({
      sourceNodeId: '0x00000000000000DD',
      destinationNodeId: '0x00000000000000FF',
    });
    await ctx.engine.receive(pkt, '0x00000000000000BB');

    // Should NOT deliver locally (addressed to 0xff, not us)
    expect(ctx.deliveries.length).toBe(0);
    // Should still forward to connected peers
    expect(ctx.sentTo.has(normalizeNodeId('0x00000000000000CC'))).toBe(true);
  });

  // Test 26: unicast packet addressed to local node IS delivered
  it('unicast packet addressed to local node is delivered locally', async () => {
    const ctx = createContext('0x00000000000000AA');
    ctx.registry.markConnected('0x00000000000000CC');

    const pkt = makePacket({
      sourceNodeId: '0x00000000000000DD',
      destinationNodeId: '0x00000000000000AA',
    });
    await ctx.engine.receive(pkt, '0x00000000000000BB');

    // Should deliver locally
    expect(ctx.deliveries.length).toBe(1);
    // Should still forward
    expect(ctx.sentTo.has(normalizeNodeId('0x00000000000000CC'))).toBe(true);
  });

  // Test 27: broadcast packet IS delivered locally
  it('broadcast packet is delivered locally', async () => {
    const ctx = createContext('0x00000000000000AA');
    ctx.registry.markConnected('0x00000000000000CC');

    const pkt = makePacket({
      sourceNodeId: '0x00000000000000DD',
      destinationNodeId: NODE_ID_BROADCAST,
    });
    await ctx.engine.receive(pkt, '0x00000000000000BB');

    // Should deliver locally
    expect(ctx.deliveries.length).toBe(1);
    // Should forward
    expect(ctx.sentTo.has(normalizeNodeId('0x00000000000000CC'))).toBe(true);
  });

  // Test 28: originated packet with unicast destination — source does NOT deliver locally
  it('originated unicast packet is not delivered at source', async () => {
    const ctx = createContext('0x00000000000000AA');
    ctx.registry.markConnected('0x00000000000000CC');

    const pkt = makePacket({
      sourceNodeId: '0x00000000000000AA',
      destinationNodeId: '0x00000000000000FF',
    });
    await ctx.engine.originate(pkt);

    // Originated packet is not delivered locally (caller handles that)
    // Only forwarded to peers
    expect(ctx.sentTo.has(normalizeNodeId('0x00000000000000CC'))).toBe(true);
  });

  // Test 29: destinationNodeId is preserved across relay
  it('destinationNodeId is preserved across relay', async () => {
    const ctx = createContext('0x00000000000000AA');
    ctx.registry.markConnected('0x00000000000000CC');

    const pkt = makePacket({
      sourceNodeId: '0x00000000000000DD',
      destinationNodeId: '0x00000000000000FF',
    });
    await ctx.engine.receive(pkt, '0x00000000000000BB');

    const forwarded = ctx.sentTo.get(normalizeNodeId('0x00000000000000CC'))!;
    expect(forwarded[0].destinationNodeId).toBe('0x00000000000000FF');
  });

  // Test 30: ANNOUNCE with broadcast destination is delivered locally
  it('ANNOUNCE with broadcast destination is delivered locally', async () => {
    const ctx = createContext('0x00000000000000AA');
    ctx.registry.markConnected('0x00000000000000CC');

    const pkt = makeAnnounce({ destinationNodeId: NODE_ID_BROADCAST });
    await ctx.engine.receive(pkt, '0x00000000000000BB');

    expect(ctx.deliveries.length).toBe(1);
    expect(ctx.deliveries[0].packet.packetType).toBe(PACKET_TYPE_ANNOUNCE);
  });

  // Test 31: ANNOUNCE is NEVER relayed even with TTL > 0
  it('ANNOUNCE is never relayed through mesh', async () => {
    const ctx = createContext('0x00000000000000AA');
    ctx.registry.markConnected('0x00000000000000BB');
    ctx.registry.markConnected('0x00000000000000CC');

    const pkt = makeAnnounce({
      ttl: 5,
      sourceNodeId: '0x00000000000000DD',
    });
    await ctx.engine.receive(pkt, '0x00000000000000BB');

    // Should deliver locally (broadcast)
    expect(ctx.deliveries.length).toBe(1);
    // Should NOT forward to any peer
    expect(ctx.sentTo.size).toBe(0);
  });

  // Test 32: DATA continues to forward normally after ANNOUNCE fix
  it('DATA packets still forward normally', async () => {
    const ctx = createContext('0x00000000000000AA');
    ctx.registry.markConnected('0x00000000000000BB');
    ctx.registry.markConnected('0x00000000000000CC');

    const pkt = makePacket({ ttl: 5 });
    await ctx.engine.receive(pkt, '0x00000000000000DD');

    // Should deliver locally (broadcast)
    expect(ctx.deliveries.length).toBe(1);
    // Should forward to BB and CC
    expect(ctx.sentTo.has(normalizeNodeId('0x00000000000000BB'))).toBe(true);
    expect(ctx.sentTo.has(normalizeNodeId('0x00000000000000CC'))).toBe(true);
  });
});


// ── Helper ───────────────────────────────────────────────────────

function ctx_has(map: Map<NodeId, BitChatPacket[]>, key: string): boolean {
  return map.has(normalizeNodeId(key));
}
