/**
 * V9B/V9C BitChat Relay Engine
 *
 * Transport-agnostic mesh packet processor. Handles:
 * - Deduplication (via DedupCache)
 * - TTL management (via TTLManager)
 * - Local delivery (destination-aware: only for addressed or broadcast packets)
 * - Controlled flooding to connected peers
 * - Loop prevention (incoming peer exclusion + DedupCache)
 *
 * Does NOT:
 * - Import NativeBLE or any platform code
 * - Implement link-level reliability (V8 handles that per hop)
 * - Alter V6A/V6B/V7/V8 protocols
 * - Generate packet IDs (caller's responsibility)
 */

import { normalizeNodeId } from '../core/BitChatPacket';
import type { BitChatPacket, NodeId } from '../core/BitChatTypes';
import { safeDecode as bitChatDecode } from '../core/BitChatPacketCodec';
import { NODE_ID_BROADCAST, PACKET_TYPE_ANNOUNCE } from '../core/BitChatConstants';
import type { MeshRouter } from './MeshRouter';
import type { DedupCache } from './DedupCache';

/**
 * Callback to send a packet to a specific peer over the transport layer.
 * The RelayEngine is transport-agnostic; this is injected.
 */
export type SendToPeerFn = (peerId: NodeId, packet: BitChatPacket) => Promise<void>;

/**
 * Callback to deliver a packet to the local application layer.
 * Called exactly once per first-seen packet that is addressed to this node.
 */
export type DeliverFn = (packet: BitChatPacket, fromPeerId?: NodeId) => void;

export interface RelayEngineParams {
  /** This node's identifier. */
  localNodeId: NodeId;
  /** Mesh router for determining relay peers. */
  router: MeshRouter;
  /** Dedup cache for detecting duplicate packets. */
  dedupCache: DedupCache;
  /** Transport-layer send function. */
  sendToPeer: SendToPeerFn;
  /** Application-layer delivery callback. */
  deliver: DeliverFn;
}

export class RelayEngine {
  private readonly localNodeId: NodeId;
  private readonly router: MeshRouter;
  private readonly dedupCache: DedupCache;
  private readonly sendToPeer: SendToPeerFn;
  private readonly deliver: DeliverFn;

  constructor(params: RelayEngineParams) {
    this.localNodeId = normalizeNodeId(params.localNodeId);
    this.router = params.router;
    this.dedupCache = params.dedupCache;
    this.sendToPeer = params.sendToPeer;
    this.deliver = params.deliver;
  }

  /**
   * Check if a packet is addressed to this node (unicast) or is broadcast.
   */
  private isAddressedToThisNode(packet: BitChatPacket): boolean {
    const dest = normalizeNodeId(packet.destinationNodeId);
    return dest === this.localNodeId || dest === NODE_ID_BROADCAST;
  }

  /**
   * Process an incoming packet from a peer.
   *
   * Flow:
   * 1. Validate packet
   * 2. Dedup check (DROP if duplicate)
   * 3. Check destination — deliver locally only if addressed to us or broadcast
   * 4. Check TTL (do not forward if 0)
   * 5. Decrement TTL
   * 6. Get relay peers (exclude incoming peer)
   * 7. Forward to each eligible peer independently
   *
   * @param packet     The received BitChat packet.
   * @param fromPeerId The peer that sent this packet (undefined if locally originated).
   */
  async receive(packet: BitChatPacket, fromPeerId?: NodeId): Promise<void> {
    // 1. Validate essential fields
    if (!packet.sourceNodeId || !packet.packetId) {
      return; // Invalid packet — silent drop
    }

    // 2. Dedup check
    const isDuplicate = this.dedupCache.checkAndMark(packet.sourceNodeId, packet.packetId);
    if (isDuplicate) {
      return; // Duplicate — DROP: no deliver, no relay
    }

    // 3. ANNOUNCE packets are direct-link-only control packets.
    // They must NEVER be relayed through the mesh. Deliver locally
    // (if addressed) but do not forward.
    if (packet.packetType === PACKET_TYPE_ANNOUNCE) {
      if (this.isAddressedToThisNode(packet)) {
        this.deliver(packet, fromPeerId);
      }
      return; // ANNOUNCE: never forward
    }

    // 4. Deliver DATA locally only if addressed to this node or broadcast
    if (this.isAddressedToThisNode(packet)) {
      this.deliver(packet, fromPeerId);
    }
    // Intermediate relay nodes do NOT deliver locally for unicast packets
    // addressed to other nodes.

    // 5. Check TTL
    const ttl = packet.ttl;
    if (ttl <= 0) {
      return; // TTL exhausted — deliver locally (if applicable) but do not forward
    }

    // 6. Decrement TTL for forwarded copy
    const forwardedTtl = ttl - 1;

    // 7. Get relay peers
    const relayPeers = this.router.getRelayPeers(fromPeerId);

    if (relayPeers.length === 0) {
      return; // No eligible peers
    }

    // 8. Create forwarded packet (same identity, new TTL)
    const forwarded: BitChatPacket = {
      version: packet.version,
      packetType: packet.packetType,
      ttl: forwardedTtl,
      sourceNodeId: packet.sourceNodeId,
      destinationNodeId: packet.destinationNodeId,
      packetId: packet.packetId,
      flags: packet.flags,
      payload: packet.payload,
    };

    // 9. Forward to each peer independently — one failure does not block others
    const results = await Promise.allSettled(
      relayPeers.map(peerId => this.sendToPeer(peerId, forwarded)),
    );

    // Log failures but do not crash
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        console.warn(
          `[RelayEngine] Failed to relay to ${relayPeers[i]}: ${result.reason}`,
        );
      }
    });
  }

  /**
   * Process a locally-originated packet.
   *
   * - Mark seen in DedupCache
   * - Forward to all connected peers (no incoming peer exclusion)
   * - Decrement TTL for forwarded copy
   *
   * Local delivery for originated packets is the caller's responsibility
   * (the caller already processed the speech before calling originate).
   *
   * @param packet  The locally-originated BitChat packet.
   */
  async originate(packet: BitChatPacket): Promise<void> {
    // Validate
    if (!packet.sourceNodeId || !packet.packetId) {
      return;
    }

    // Mark seen in DedupCache
    this.dedupCache.checkAndMark(packet.sourceNodeId, packet.packetId);

    // Check TTL
    if (packet.ttl <= 0) {
      return; // TTL exhausted — nothing to forward
    }

    // Decrement TTL for forwarded copy
    const forwardedTtl = packet.ttl - 1;

    // Get relay peers (no incoming peer exclusion for originated packets)
    const relayPeers = this.router.getRelayPeers();

    if (relayPeers.length === 0) {
      return;
    }

    // Create forwarded packet
    const forwarded: BitChatPacket = {
      version: packet.version,
      packetType: packet.packetType,
      ttl: forwardedTtl,
      sourceNodeId: packet.sourceNodeId,
      destinationNodeId: packet.destinationNodeId,
      packetId: packet.packetId,
      flags: packet.flags,
      payload: packet.payload,
    };

    // Forward independently
    const results = await Promise.allSettled(
      relayPeers.map(peerId => this.sendToPeer(peerId, forwarded)),
    );

    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        console.warn(
          `[RelayEngine] Failed to relay originated packet to ${relayPeers[i]}: ${result.reason}`,
        );
      }
    });
  }
}
