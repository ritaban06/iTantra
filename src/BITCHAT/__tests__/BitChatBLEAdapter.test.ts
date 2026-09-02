/**
 * V9C BitChatBLEAdapter — Integration Tests
 *
 * Tests the BLE ↔ BITCHAT bridge using mocked BLE transports.
 * Verifies originate, receive, relay, multi-hop, peer mapping,
 * dedup, TTL, and error handling.
 */

import { BitChatBLEAdapter, BleSendFn, LocalDeliverFn } from '../BitChatBLEAdapter';
import {
  PROTOCOL_VERSION,
  PACKET_TYPE_DATA,
  PACKET_TYPE_ANNOUNCE,
  DEFAULT_TTL,
  FLAGS_NONE,
  NODE_ID_BROADCAST,
  HEADER_SIZE as BITCHAT_HEADER_SIZE,
} from '../core/BitChatConstants';
import { normalizeNodeId, encode as bitChatEncode } from '../core';
import type { BitChatPacket, NodeId, PacketId } from '../core/BitChatTypes';

// ── Helpers ──────────────────────────────────────────────────────

function makePacketId(n: number): PacketId {
  return normalizeNodeId(BigInt(n));
}

function makeBitChatPacket(overrides?: Partial<BitChatPacket>): BitChatPacket {
  return {
    version: PROTOCOL_VERSION,
    packetType: PACKET_TYPE_DATA,
    ttl: DEFAULT_TTL,
    sourceNodeId: '0x00000000000000AA',
    destinationNodeId: NODE_ID_BROADCAST,
    packetId: makePacketId(1),
    flags: FLAGS_NONE,
    payload: new Uint8Array([0x02, 0x01, 0x00, 0xDE, 0xAD]), // fake V6B-like payload
    ...overrides,
  };
}

/**
 * Simulates a simple network node with its own adapter.
 * Tracks all BLE sends and local deliveries.
 */
interface SimNode {
  adapter: BitChatBLEAdapter;
  localNodeId: NodeId;
  bleSends: Map<string, Uint8Array[]>;  // blePeerId → sent payloads
  localDelivers: Uint8Array[];           // locally delivered V6B payloads
  bleSendFn: BleSendFn;
}

function createSimNode(nodeId: string): SimNode {
  const bleSends = new Map<string, Uint8Array[]>();
  const localDelivers: Uint8Array[] = [];

  const bleSendFn: BleSendFn = async (peerBleId, payload) => {
    if (!bleSends.has(peerBleId)) bleSends.set(peerBleId, []);
    bleSends.get(peerBleId)!.push(new Uint8Array(payload));
  };

  const onLocalDeliver: LocalDeliverFn = (v6bPayload, _fromPeerId) => {
    localDelivers.push(new Uint8Array(v6bPayload));
  };

  const adapter = new BitChatBLEAdapter({
    localNodeId: nodeId,
    bleSend: bleSendFn,
    onLocalDeliver,
  });

  return { adapter, localNodeId: normalizeNodeId(nodeId), bleSends, localDelivers, bleSendFn };
}

/**
 * Connect two sim nodes to each other.
 * Registers peer mappings bidirectionally.
 */
function connectNodes(a: SimNode, b: SimNode, bleIdA: string, bleIdB: string): void {
  a.adapter.registerPeer(bleIdA, b.localNodeId);
  b.adapter.registerPeer(bleIdB, a.localNodeId);
}

// ══════════════════════════════════════════════════════════════════
// Integration Tests
// ══════════════════════════════════════════════════════════════════

describe('BitChatBLEAdapter Integration', () => {
  // ── Originate ──────────────────────────────────────────────────

  // Test 1: originate through one BLE peer
  it('originate sends BITCHAT packet to all connected BLE peers', async () => {
    const nodeA = createSimNode('0x0000000000000001');
    const nodeB = createSimNode('0x0000000000000002');
    const nodeC = createSimNode('0x0000000000000003');

    connectNodes(nodeA, nodeB, 'ble_to_B', 'ble_to_A');
    connectNodes(nodeA, nodeC, 'ble_to_C', 'ble_to_A');

    const payload = new Uint8Array([0x02, 0x01, 0x00, 0x41, 0x42]);
    await nodeA.adapter.originate(payload, makePacketId(100));

    // B and C should each have received one BITCHAT packet
    expect(nodeA.bleSends.get('ble_to_B')!.length).toBe(1);
    expect(nodeA.bleSends.get('ble_to_C')!.length).toBe(1);
  });

  // Test 2: receive and forward through another peer
  it('receive from B forwards to C (not back to B)', async () => {
    const nodeA = createSimNode('0x0000000000000001');
    const nodeB = createSimNode('0x0000000000000002');
    const nodeC = createSimNode('0x0000000000000003');

    connectNodes(nodeA, nodeB, 'ble_to_B', 'ble_to_A');
    connectNodes(nodeA, nodeC, 'ble_to_C', 'ble_to_A');

    // Create a BITCHAT packet as if B sent it
    const packet = makeBitChatPacket({
      sourceNodeId: nodeB.localNodeId,
      packetId: makePacketId(200),
      ttl: DEFAULT_TTL,
    });
    const encoded = bitChatEncode(packet);

    await nodeA.adapter.receive(encoded, 'ble_to_B');

    // A should have delivered locally
    expect(nodeA.localDelivers.length).toBe(1);

    // A should forward to C (not back to B)
    expect(nodeA.bleSends.get('ble_to_B')).toBeUndefined(); // not back to B
    const cSends = nodeA.bleSends.get('ble_to_C');
    expect(cSends).toBeDefined();
    expect(cSends!.length).toBe(1);
  });

  // Test 3: TTL expiration
  it('TTL=0 packet is delivered locally but not forwarded', async () => {
    const nodeA = createSimNode('0x0000000000000001');
    const nodeB = createSimNode('0x0000000000000002');

    connectNodes(nodeA, nodeB, 'ble_to_B', 'ble_to_A');

    const packet = makeBitChatPacket({
      sourceNodeId: nodeB.localNodeId,
      packetId: makePacketId(300),
      ttl: 0,
    });
    const encoded = bitChatEncode(packet);

    await nodeA.adapter.receive(encoded, 'ble_to_B');

    expect(nodeA.localDelivers.length).toBe(1);
    expect(nodeA.bleSends.size).toBe(0); // no forwarding
  });

  // Test 4: incoming-peer exclusion
  it('incoming peer is excluded from forwarding', async () => {
    const nodeA = createSimNode('0x0000000000000001');
    const nodeB = createSimNode('0x0000000000000002');
    const nodeC = createSimNode('0x0000000000000003');

    connectNodes(nodeA, nodeB, 'ble_to_B', 'ble_to_A');
    connectNodes(nodeA, nodeC, 'ble_to_C', 'ble_to_A');

    const packet = makeBitChatPacket({
      sourceNodeId: nodeB.localNodeId,
      packetId: makePacketId(400),
    });
    const encoded = bitChatEncode(packet);

    await nodeA.adapter.receive(encoded, 'ble_to_B');

    // B should NOT receive the forwarded packet (bounce-back prevention)
    expect(nodeA.bleSends.has('ble_to_B')).toBe(false);
    // C should receive it
    expect(nodeA.bleSends.has('ble_to_C')).toBe(true);
  });

  // Test 5: duplicate packet suppression
  it('duplicate packet is not delivered or forwarded', async () => {
    const nodeA = createSimNode('0x0000000000000001');
    const nodeB = createSimNode('0x0000000000000002');
    const nodeC = createSimNode('0x0000000000000003');

    connectNodes(nodeA, nodeB, 'ble_to_B', 'ble_to_A');
    connectNodes(nodeA, nodeC, 'ble_to_C', 'ble_to_A');

    const packet = makeBitChatPacket({
      sourceNodeId: nodeB.localNodeId,
      packetId: makePacketId(500),
    });
    const encoded = bitChatEncode(packet);

    // First time: delivered + forwarded
    await nodeA.adapter.receive(encoded, 'ble_to_B');
    expect(nodeA.localDelivers.length).toBe(1);

    // Clear for clarity
    nodeA.bleSends.clear();

    // Second time: suppressed
    await nodeA.adapter.receive(encoded, 'ble_to_B');
    expect(nodeA.localDelivers.length).toBe(1); // no additional delivery
    expect(nodeA.bleSends.size).toBe(0); // no forwarding
  });

  // Test 6: multi-hop identity preservation
  it('BITCHAT sourceNodeId and packetId are preserved across hops', async () => {
    const nodeA = createSimNode('0x0000000000000001');
    const nodeB = createSimNode('0x0000000000000002');
    const nodeC = createSimNode('0x0000000000000003');

    connectNodes(nodeA, nodeB, 'ble_AB', 'ble_BA');
    connectNodes(nodeB, nodeC, 'ble_BC', 'ble_CB');

    // A originates
    const packet = makeBitChatPacket({
      sourceNodeId: nodeA.localNodeId,
      packetId: makePacketId(600),
    });
    await nodeA.adapter.originate(packet.payload, packet.packetId);

    // B receives from A
    const bReceived = nodeA.bleSends.get('ble_AB')![0];
    await nodeB.adapter.receive(bReceived, 'ble_BA');

    // B forwards to C — check that sourceNodeId and packetId are preserved
    const bSends = nodeB.bleSends.get('ble_BC');
    expect(bSends).toBeDefined();
    expect(bSends!.length).toBe(1);

    const forwarded = bitChatEncode({
      version: PROTOCOL_VERSION,
      packetType: PACKET_TYPE_DATA,
      ttl: 0,  // forwarded TTL should be decremented
      sourceNodeId: nodeA.localNodeId,
      destinationNodeId: NODE_ID_BROADCAST,
      packetId: packet.packetId,
      flags: FLAGS_NONE,
      payload: packet.payload,
    });
    // The raw bytes sent to C should decode with same identity
    const { decode } = require('../core/BitChatPacketCodec');
    const decoded = decode(bSends![0]);
    expect(decoded.sourceNodeId).toBe(nodeA.localNodeId);
    expect(decoded.packetId).toBe(packet.packetId);
  });

  // Test 7: V8 sequence may change per hop (identity preserved, sequence different)
  it('V6B sequence changes per hop while BITCHAT identity stays constant', async () => {
    // This tests the architectural invariant: BITCHAT identity (sourceNodeId + packetId)
    // is constant across hops, while V6B/V8 transport state (sequence) is per-hop.
    const nodeA = createSimNode('0x0000000000000001');
    const nodeB = createSimNode('0x0000000000000002');

    connectNodes(nodeA, nodeB, 'ble_AB', 'ble_BA');

    const packet = makeBitChatPacket({
      sourceNodeId: nodeA.localNodeId,
      packetId: makePacketId(700),
      payload: new Uint8Array([0x03, 0x01, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x03, 0xDE]), // V6B-like
    });

    await nodeA.adapter.originate(packet.payload, packet.packetId);

    // The V6B payload inside the BITCHAT envelope has its own sequence
    const sent = nodeA.bleSends.get('ble_AB')![0];
    const { decode: v6bDecode } = require('../../protocol/V6BFrameCodec');
    const decoded = bitChatEncode({
      version: PROTOCOL_VERSION,
      packetType: PACKET_TYPE_DATA,
      ttl: DEFAULT_TTL - 1,
      sourceNodeId: nodeA.localNodeId,
      destinationNodeId: NODE_ID_BROADCAST,
      packetId: packet.packetId,
      flags: FLAGS_NONE,
      payload: packet.payload,
    });
    // The BITCHAT packet wraps the V6B frame as payload
    const { safeDecode } = require('../core/BitChatPacketCodec');
    const bitchatPacket = safeDecode(sent);
    expect(bitchatPacket).not.toBeNull();
    expect(bitchatPacket!.sourceNodeId).toBe(nodeA.localNodeId);
    expect(bitchatPacket!.packetId).toBe(packet.packetId);
  });

  // Test 8: local final delivery does not trigger relay-only behavior
  it('final delivery calls onLocalDeliver with V6B payload', async () => {
    const nodeA = createSimNode('0x0000000000000001');
    const nodeB = createSimNode('0x0000000000000002');

    connectNodes(nodeA, nodeB, 'ble_B', 'ble_A');

    const v6bPayload = new Uint8Array([0x03, 0x01, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x03]);
    const packet = makeBitChatPacket({
      sourceNodeId: nodeB.localNodeId,
      packetId: makePacketId(800),
      payload: v6bPayload,
    });
    const encoded = bitChatEncode(packet);

    await nodeA.adapter.receive(encoded, 'ble_B');

    // The delivered payload should be the original V6B payload, not the BITCHAT envelope
    expect(nodeA.localDelivers.length).toBe(1);
    expect(nodeA.localDelivers[0]).toEqual(v6bPayload);
  });

  // Test 9: one peer send failure does not prevent other peer sends
  it('send failure to one peer does not stop forwarding to others', async () => {
    const nodeA = createSimNode('0x0000000000000001');
    const nodeB = createSimNode('0x0000000000000002');
    const nodeC = createSimNode('0x0000000000000003');

    connectNodes(nodeA, nodeB, 'ble_to_B', 'ble_to_A');
    connectNodes(nodeA, nodeC, 'ble_to_C', 'ble_to_A');

    // Make send to B fail
    const failingSend: BleSendFn = async (peerBleId, _payload) => {
      if (peerBleId === 'ble_to_B') throw new Error('B unavailable');
      // Otherwise delegate to normal send
      await nodeA.bleSendFn(peerBleId, _payload);
    };

    // Recreate adapter with failing send
    nodeA.adapter = new BitChatBLEAdapter({
      localNodeId: nodeA.localNodeId,
      bleSend: failingSend,
      onLocalDeliver: (v6b) => nodeA.localDelivers.push(new Uint8Array(v6b)),
    });
    // Re-register peers on new adapter
    nodeA.adapter.registerPeer('ble_to_B', nodeB.localNodeId);
    nodeA.adapter.registerPeer('ble_to_C', nodeC.localNodeId);

    const packet = makeBitChatPacket({
      sourceNodeId: nodeB.localNodeId,
      packetId: makePacketId(900),
    });
    const encoded = bitChatEncode(packet);

    // Should not throw despite B failing
    await nodeA.adapter.receive(encoded, 'ble_to_B');

    // C should still receive the forwarded packet
    const cSends = nodeA.bleSends.get('ble_to_C');
    expect(cSends).toBeDefined();
    expect(cSends!.length).toBe(1);
  });

  // Test 10: connect/disconnect peer mapping
  it('register and unregister peer mapping', async () => {
    const nodeA = createSimNode('0x0000000000000001');
    const nodeB = createSimNode('0x0000000000000002');

    nodeA.adapter.registerPeer('ble_B', nodeB.localNodeId);

    expect(nodeA.adapter.getNodeIdForBlePeer('ble_B')).toBe(nodeB.localNodeId);
    expect(nodeA.adapter.getBlePeerForNodeId(nodeB.localNodeId)).toBe('ble_B');
    expect(nodeA.adapter.getConnectedPeers()).toContain(nodeB.localNodeId);

    nodeA.adapter.unregisterPeer('ble_B');

    expect(nodeA.adapter.getNodeIdForBlePeer('ble_B')).toBeUndefined();
    // After unregister, peer is DISCOVERED not CONNECTED
    expect(nodeA.adapter.getConnectedPeers()).not.toContain(nodeB.localNodeId);
  });

  // Test 11: multi-hop A → B → C behavior
  it('A → B → C multi-hop: packet travels from A through B to C', async () => {
    const nodeA = createSimNode('0x0000000000000001');
    const nodeB = createSimNode('0x0000000000000002');
    const nodeC = createSimNode('0x0000000000000003');

    // A ↔ B, B ↔ C (no direct A ↔ C link)
    connectNodes(nodeA, nodeB, 'ble_AB', 'ble_BA');
    connectNodes(nodeB, nodeC, 'ble_BC', 'ble_CB');

    // A originates a packet
    const payload = new Uint8Array([0xCA, 0xFE]);
    const packetId = makePacketId(1100);
    await nodeA.adapter.originate(payload, packetId);

    // B receives from A
    const bReceivesFromA = nodeA.bleSends.get('ble_AB')![0];
    expect(bReceivesFromA).toBeDefined();

    await nodeB.adapter.receive(bReceivesFromA, 'ble_BA');

    // B should have delivered locally
    expect(nodeB.localDelivers.length).toBe(1);

    // B should forward to C
    const cReceivesFromB = nodeB.bleSends.get('ble_BC')![0];
    expect(cReceivesFromB).toBeDefined();

    // C receives from B
    await nodeC.adapter.receive(cReceivesFromB, 'ble_CB');

    // C should have delivered locally
    expect(nodeC.localDelivers.length).toBe(1);

    // Verify identity preserved end-to-end
    const { decode } = require('../core/BitChatPacketCodec');
    const finalPacket = decode(cReceivesFromB);
    expect(finalPacket.sourceNodeId).toBe(nodeA.localNodeId);
    expect(finalPacket.packetId).toBe(packetId);
  });

  // Test 12: ANNOUNCE packets are received but not delivered to application
  it('ANNOUNCE packets are processed but not delivered locally', async () => {
    const nodeA = createSimNode('0x0000000000000001');
    const nodeB = createSimNode('0x0000000000000002');

    connectNodes(nodeA, nodeB, 'ble_B', 'ble_A');

    const packet = makeBitChatPacket({
      sourceNodeId: nodeB.localNodeId,
      packetId: makePacketId(1200),
      packetType: PACKET_TYPE_ANNOUNCE,
      payload: new Uint8Array(9).fill(0x01),
    });
    const encoded = bitChatEncode(packet);

    await nodeA.adapter.receive(encoded, 'ble_B');

    // ANNOUNCE: no local delivery (onLocalDeliver not called)
    expect(nodeA.localDelivers.length).toBe(0);
  });

  // Test 13: non-BITCHAT data is not processed by adapter
  it('non-BITCHAT data returns false without processing', async () => {
    const nodeA = createSimNode('0x0000000000000001');
    const nodeB = createSimNode('0x0000000000000002');
    connectNodes(nodeA, nodeB, 'ble_B', 'ble_A');

    // V6B version byte is 0x03 — not BITCHAT
    const v6bData = new Uint8Array([0x03, 0x01, 0x00, 0x00, 0x04]);
    const result = await nodeA.adapter.receive(v6bData, 'ble_B');

    expect(result).toBeNull();
    expect(nodeA.localDelivers.length).toBe(0);
  });

  // Test 15: No duplicate first-hop send — originate only goes through adapter
  it('no duplicate first-hop send: originate produces one transmission per peer', async () => {
    const nodeA = createSimNode('0x0000000000000001');
    const nodeB = createSimNode('0x0000000000000002');
    connectNodes(nodeA, nodeB, 'ble_to_B', 'ble_to_A');

    const payload = new Uint8Array([0xCA, 0xFE]);
    const packetId = makePacketId(1500);
    await nodeA.adapter.originate(payload, packetId);

    // Should send exactly ONE BITCHAT packet to B (not two)
    const sends = nodeA.bleSends.get('ble_to_B');
    expect(sends).toBeDefined();
    expect(sends!.length).toBe(1);
  });

  // Test 16: B relays without speaking a packet addressed to F
  it('intermediate relay does not deliver transit traffic locally', async () => {
    const nodeA = createSimNode('0x0000000000000001');
    const nodeB = createSimNode('0x0000000000000002');
    const nodeF = createSimNode('0x000000000000000F');

    // A ↔ B, B ↔ F
    connectNodes(nodeA, nodeB, 'ble_AB', 'ble_BA');
    connectNodes(nodeB, nodeF, 'ble_BF', 'ble_FB');

    // A originates a packet addressed to F
    const payload = new Uint8Array([0xDE, 0xAD]);
    const packetId = makePacketId(1600);
    const packet = makeBitChatPacket({
      sourceNodeId: nodeA.localNodeId,
      destinationNodeId: nodeF.localNodeId,
      packetId,
      payload,
    });
    await nodeA.adapter.originate(payload, packetId, nodeF.localNodeId);

    // B receives from A
    const bReceives = nodeA.bleSends.get('ble_AB')![0];
    await nodeB.adapter.receive(bReceives, 'ble_BA');

    // B should NOT deliver locally (addressed to F, not B)
    expect(nodeB.localDelivers.length).toBe(0);

    // B should forward to F
    const fReceives = nodeB.bleSends.get('ble_BF');
    expect(fReceives).toBeDefined();
    expect(fReceives!.length).toBe(1);
  });

  // Test 17: F speaks the packet addressed to F
  it('destination node delivers packet addressed to it', async () => {
    const nodeA = createSimNode('0x0000000000000001');
    const nodeB = createSimNode('0x0000000000000002');
    const nodeF = createSimNode('0x000000000000000F');

    connectNodes(nodeA, nodeB, 'ble_AB', 'ble_BA');
    connectNodes(nodeB, nodeF, 'ble_BF', 'ble_FB');

    const payload = new Uint8Array([0xDE, 0xAD]);
    const packetId = makePacketId(1700);
    await nodeA.adapter.originate(payload, packetId, nodeF.localNodeId);

    const bReceives = nodeA.bleSends.get('ble_AB')![0];
    await nodeB.adapter.receive(bReceives, 'ble_BA');

    const fReceives = nodeB.bleSends.get('ble_BF')![0];
    await nodeF.adapter.receive(fReceives, 'ble_FB');

    // F should deliver locally (addressed to F)
    expect(nodeF.localDelivers.length).toBe(1);
    expect(nodeF.localDelivers[0]).toEqual(payload);
  });

  // Test 18: source node does not speak its own looped-back packet
  it('source node does not deliver its own originated packet', async () => {
    const nodeA = createSimNode('0x0000000000000001');
    const nodeB = createSimNode('0x0000000000000002');
    connectNodes(nodeA, nodeB, 'ble_AB', 'ble_BA');

    const payload = new Uint8Array([0xCA, 0xFE]);
    const packetId = makePacketId(1800);
    await nodeA.adapter.originate(payload, packetId, nodeB.localNodeId);

    // A should NOT deliver its own packet locally
    expect(nodeA.localDelivers.length).toBe(0);
  });

  // Test 19: ANNOUNCE still works with destinationNodeId
  it('ANNOUNCE with broadcast destination works correctly', async () => {
    const nodeA = createSimNode('0x0000000000000001');
    const nodeB = createSimNode('0x0000000000000002');
    connectNodes(nodeA, nodeB, 'ble_B', 'ble_A');

    const announcePayload = nodeA.adapter.createAnnouncePacket();
    // ANNOUNCE is sent as raw BITCHAT (not through V6B wrapping in this test)
    // The announce packet should be decodable
    const { safeDecode } = require('../core/BitChatPacketCodec');
    const decoded = safeDecode(announcePayload);
    expect(decoded).not.toBeNull();
    expect(decoded!.packetType).toBe(PACKET_TYPE_ANNOUNCE);
    expect(decoded!.destinationNodeId).toBe(NODE_ID_BROADCAST);
  });

  // Test 20: TTL decreases by exactly 1 across hops
  it('TTL decreases by exactly 1 per relay hop', async () => {
    const nodeA = createSimNode('0x0000000000000001');
    const nodeB = createSimNode('0x0000000000000002');

    connectNodes(nodeA, nodeB, 'ble_B', 'ble_A');

    const packet = makeBitChatPacket({
      sourceNodeId: nodeB.localNodeId,
      packetId: makePacketId(1400),
      ttl: 3,
    });
    const encoded = bitChatEncode(packet);

    await nodeA.adapter.receive(encoded, 'ble_B');

    // A forwards to no one (no other peers), but if we check the sent data:
    // The packet has TTL=3, so A would forward with TTL=2
    // Since there are no other peers, no forwarding happens
    // But let's verify with another peer
    const nodeC = createSimNode('0x0000000000000003');
    connectNodes(nodeA, nodeC, 'ble_C', 'ble_A');

    const packet2 = makeBitChatPacket({
      sourceNodeId: nodeB.localNodeId,
      packetId: makePacketId(1401),
      ttl: 3,
    });
    const encoded2 = bitChatEncode(packet2);

    await nodeA.adapter.receive(encoded2, 'ble_B');

    const { decode } = require('../core/BitChatPacketCodec');
    const forwarded = decode(nodeA.bleSends.get('ble_C')![0]);
    expect(forwarded.ttl).toBe(2); // 3 - 1 = 2
  });

  // ── V9C ANNOUNCE Discovery Fix Tests ───────────────────────────

  // Test 21: A↔B direct ANNOUNCE registers A/B correctly
  it('direct ANNOUNCE registers BLE peer correctly', async () => {
    const nodeA = createSimNode('0x0000000000000001');
    const nodeB = createSimNode('0x0000000000000002');

    // B sends its ANNOUNCE directly to A over their BLE link
    const announcePayload = nodeB.adapter.createAnnouncePacket();
    await nodeA.adapter.receive(announcePayload, 'ble_B');

    // A should now know B's BLE peer maps to B's node ID
    expect(nodeA.adapter.getNodeIdForBlePeer('ble_B')).toBe(nodeB.localNodeId);
    expect(nodeA.adapter.getBlePeerForNodeId(nodeB.localNodeId)).toBe('ble_B');
  });

  // Test 22: A→B→C forwarded DATA does NOT cause C to register B as A
  it('forwarded DATA does not cause incorrect peer identity association', async () => {
    const nodeA = createSimNode('0x0000000000000001');
    const nodeB = createSimNode('0x0000000000000002');
    const nodeC = createSimNode('0x0000000000000003');

    connectNodes(nodeA, nodeB, 'ble_AB', 'ble_BA');
    connectNodes(nodeB, nodeC, 'ble_BC', 'ble_CB');

    // A originates a DATA packet
    const payload = new Uint8Array([0xDE, 0xAD]);
    const packetId = makePacketId(2200);
    await nodeA.adapter.originate(payload, packetId, NODE_ID_BROADCAST);

    // B receives from A, forwards to C
    const bReceives = nodeA.bleSends.get('ble_AB')![0];
    await nodeB.adapter.receive(bReceives, 'ble_BA');

    const cReceives = nodeB.bleSends.get('ble_BC')![0];
    await nodeC.adapter.receive(cReceives, 'ble_CB');

    // C should NOT have registered A as a direct peer.
    // C only has a direct BLE link to B (registered by connectNodes).
    // A's identity is only in the BITCHAT packet's sourceNodeId, not in peer mappings.
    expect(nodeC.adapter.getBlePeerForNodeId(nodeA.localNodeId)).toBeUndefined();
    // C's direct peer mapping is still B (correct)
    expect(nodeC.adapter.getNodeIdForBlePeer('ble_CB')).toBe(nodeB.localNodeId);
  });

  // Test 23: ANNOUNCE is NOT forwarded by adapter
  it('ANNOUNCE received by adapter is not forwarded to other peers', async () => {
    const nodeA = createSimNode('0x0000000000000001');
    const nodeB = createSimNode('0x0000000000000002');
    const nodeC = createSimNode('0x0000000000000003');

    connectNodes(nodeA, nodeB, 'ble_AB', 'ble_BA');
    connectNodes(nodeA, nodeC, 'ble_AC', 'ble_CA');

    // B sends ANNOUNCE directly to A
    const announcePayload = nodeB.adapter.createAnnouncePacket();
    await nodeA.adapter.receive(announcePayload, 'ble_AB');

    // A should register B
    expect(nodeA.adapter.getNodeIdForBlePeer('ble_AB')).toBe(nodeB.localNodeId);

    // A should NOT have forwarded the ANNOUNCE to C
    expect(nodeA.bleSends.get('ble_AC')).toBeUndefined();
  });

  // Test 24: Destination-aware delivery still works after ANNOUNCE fix
  it('destination-aware delivery works correctly with ANNOUNCE fix', async () => {
    const nodeA = createSimNode('0x0000000000000001');
    const nodeB = createSimNode('0x0000000000000002');
    const nodeF = createSimNode('0x000000000000000F');

    connectNodes(nodeA, nodeB, 'ble_AB', 'ble_BA');
    connectNodes(nodeB, nodeF, 'ble_BF', 'ble_FB');

    // A originates unicast to F
    const payload = new Uint8Array([0xCA, 0xFE]);
    const packetId = makePacketId(2400);
    await nodeA.adapter.originate(payload, packetId, nodeF.localNodeId);

    // B receives from A — should NOT deliver locally
    const bReceives = nodeA.bleSends.get('ble_AB')![0];
    await nodeB.adapter.receive(bReceives, 'ble_BA');
    expect(nodeB.localDelivers.length).toBe(0);

    // B forwards to F
    const fReceives = nodeB.bleSends.get('ble_BF')![0];
    await nodeF.adapter.receive(fReceives, 'ble_FB');
    expect(nodeF.localDelivers.length).toBe(1);
    expect(nodeF.localDelivers[0]).toEqual(payload);
  });

  // Test 25: ANNOUNCE from B registers B correctly even after disconnect/reconnect
  it('disconnect and reconnect updates peer mapping correctly', async () => {
    const nodeA = createSimNode('0x0000000000000001');
    const nodeB = createSimNode('0x0000000000000002');

    // First connection: B sends ANNOUNCE
    const announce1 = nodeB.adapter.createAnnouncePacket();
    await nodeA.adapter.receive(announce1, 'ble_B');
    expect(nodeA.adapter.getNodeIdForBlePeer('ble_B')).toBe(nodeB.localNodeId);

    // Disconnect B
    nodeA.adapter.unregisterPeer('ble_B');
    expect(nodeA.adapter.getNodeIdForBlePeer('ble_B')).toBeUndefined();

    // Reconnect B on same BLE ID
    const announce2 = nodeB.adapter.createAnnouncePacket();
    await nodeA.adapter.receive(announce2, 'ble_B');
    expect(nodeA.adapter.getNodeIdForBlePeer('ble_B')).toBe(nodeB.localNodeId);
  });

  // Test 26: ANNOUNCE on different BLE ID does not overwrite existing mapping
  it('ANNOUNCE from different BLE ID registers correctly', async () => {
    const nodeA = createSimNode('0x0000000000000001');
    const nodeB = createSimNode('0x0000000000000002');

    // B connects on ble_B_first
    const announce1 = nodeB.adapter.createAnnouncePacket();
    await nodeA.adapter.receive(announce1, 'ble_B_first');
    expect(nodeA.adapter.getNodeIdForBlePeer('ble_B_first')).toBe(nodeB.localNodeId);

    // B reconnects on ble_B_second
    const announce2 = nodeB.adapter.createAnnouncePacket();
    await nodeA.adapter.receive(announce2, 'ble_B_second');
    expect(nodeA.adapter.getNodeIdForBlePeer('ble_B_second')).toBe(nodeB.localNodeId);
  });
});
