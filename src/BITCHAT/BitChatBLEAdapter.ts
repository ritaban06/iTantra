/**
 * V9D BitChat ↔ BLE Adapter
 *
 * Integration bridge between the existing BLE transport (V6B/V8)
 * and the BITCHAT mesh layer (V9A/V9B/V9C/V9D).
 *
 * Responsibilities:
 * - Detect incoming BITCHAT packets from BLE data
 * - Route BITCHAT packets through RelayEngine (destination-aware)
 * - Map BLE peer IDs to BITCHAT node IDs via direct ANNOUNCE exchange
 * - Track mesh-discovered nodes via DISCOVERY packets (MeshDiscoveryRegistry)
 * - Originate BITCHAT packets from local payloads (with destinationNodeId)
 * - Forward RelayEngine-eligible packets through V6B/V8
 * - Deliver locally-recovered payloads for application decode
 * - Skip local delivery for self-originated packets (relay-only behavior)
 *
 * V9D changes:
 * - DISCOVERY packet type for mesh-wide node identity propagation
 * - MeshDiscoveryRegistry for tracking remote nodes
 * - DISCOVERY packets flood like DATA but do NOT modify BLE peer mapping
 * - Discovered Node IDs are usable as destinationNodeId
 *
 * Does NOT:
 * - Import NativeBLE (transport-agnostic)
 * - Redesign V6A/V6B/V7/V8 protocols
 * - Implement link reliability (V8 handles that per hop)
 * - Implement STT/TTS (useBLEVoiceMode handles that)
 * - Implement routing tables
 */

import { normalizeNodeId } from './core/BitChatPacket';
import { safeDecode as bitChatSafeDecode, encode as bitChatEncode } from './core/BitChatPacketCodec';
import {
  PROTOCOL_VERSION,
  HEADER_SIZE as BITCHAT_HEADER_SIZE,
  DEFAULT_TTL,
  PACKET_TYPE_DATA,
  PACKET_TYPE_ANNOUNCE,
  PACKET_TYPE_DISCOVERY,
  FLAGS_NONE,
  NODE_ID_BROADCAST,
} from './core/BitChatConstants';
import type { BitChatPacket, NodeId, PacketId } from './core/BitChatTypes';
import { encodeAnnounce, safeDecodeAnnounce } from './AnnounceCodec';
import { encodeDiscovery, safeDecodeDiscovery } from './DiscoveryPacketCodec';
import { RelayEngine } from './mesh/RelayEngine';
import { MeshRouter } from './mesh/MeshRouter';
import { DedupCache } from './mesh/DedupCache';
import { MeshDiscoveryRegistry } from './mesh/MeshDiscoveryRegistry';
import { PeerRegistry } from './peer/PeerRegistry';

// ── Types ────────────────────────────────────────────────────────

/** Callback to send raw bytes over BLE to a specific peer. */
export type BleSendFn = (peerBleId: string, payload: Uint8Array) => Promise<void>;

/** Callback for locally-delivered payloads (V6B frames for application decode). */
export type LocalDeliverFn = (v6bPayload: Uint8Array, fromPeerId?: string) => void;

export interface BitChatBLEAdapterParams {
  /** This node's BITCHAT identity. */
  localNodeId: NodeId;
  /** Send raw bytes to a BLE peer. */
  bleSend: BleSendFn;
  /** Callback for locally-delivered payloads (V6B frames). */
  onLocalDeliver: LocalDeliverFn;
  /**
   * Optional callback fired when a valid ANNOUNCE is received from a BLE peer.
   * Used by the integration layer to answer with its own ANNOUNCE so peer
   * registration becomes symmetric even if a connection-time ANNOUNCE was lost.
   */
  onAnnounceReceived?: AnnounceReceivedFn;
}

/** Mapping from BITCHAT NodeId to BLE peer ID string. */
interface PeerMapping {
  blePeerId: string;
  bitchatNodeId: NodeId;
}

/** Optional callback invoked when a valid ANNOUNCE is received from a BLE peer. */
export type AnnounceReceivedFn = (blePeerId: string, remoteNodeId: NodeId) => void;

// ── Adapter ──────────────────────────────────────────────────────

export class BitChatBLEAdapter {
  private readonly localNodeId: NodeId;
  private readonly bleSend: BleSendFn;
  private readonly onLocalDeliver: LocalDeliverFn;
  private readonly onAnnounceReceived?: AnnounceReceivedFn;

  /** BITCHAT mesh components. */
  readonly peerRegistry: PeerRegistry;
  readonly dedupCache: DedupCache;
  readonly meshRouter: MeshRouter;
  readonly relayEngine: RelayEngine;

  /** V9D: Mesh discovery registry for remote nodes. */
  readonly discoveryRegistry: MeshDiscoveryRegistry;

  /** BLE peer ID ↔ BITCHAT NodeId mapping (direct BLE connections only). */
  private peerMappings = new Map<string, PeerMapping>();
  private reverseMappings = new Map<NodeId, PeerMapping>();

  /**
   * Packet ID of the last originated packet.
   * Used to suppress local delivery for self-originated packets.
   */
  private originatedPacketId: PacketId | null = null;

  constructor(params: BitChatBLEAdapterParams) {
    this.localNodeId = normalizeNodeId(params.localNodeId);
    this.bleSend = params.bleSend;
    this.onLocalDeliver = params.onLocalDeliver;
    this.onAnnounceReceived = params.onAnnounceReceived;

    // Initialize BITCHAT mesh components
    this.peerRegistry = new PeerRegistry();
    this.dedupCache = new DedupCache();
    this.meshRouter = new MeshRouter(this.localNodeId, this.peerRegistry);
    this.discoveryRegistry = new MeshDiscoveryRegistry();

    // sendToPeer: maps BITCHAT NodeId → BLE peer ID → bleSend.
    // A missing mapping or failed transmission THROWS so RelayEngine counts
    // this peer as not-forwarded (honest originate result).
    const sendToPeer = async (peerId: NodeId, packet: BitChatPacket): Promise<void> => {
      const mapping = this.reverseMappings.get(peerId);
      if (!mapping) {
        throw new Error(`No BLE mapping for peer ${peerId}`);
      }
      const encoded = bitChatEncode(packet);
      await this.bleSend(mapping.blePeerId, encoded);
    };

    // deliver: called by RelayEngine for first-seen packets addressed to this node
    const deliver = (packet: BitChatPacket, fromPeerId?: NodeId): void => {
      if (packet.packetType !== PACKET_TYPE_DATA) {
        return; // ANNOUNCE/DISCOVERY: consumed at mesh layer, not delivered to application
      }

      // Skip local delivery for self-originated packets.
      if (this.originatedPacketId !== null && packet.packetId === this.originatedPacketId) {
        this.originatedPacketId = null;
        return;
      }

      // Deliver V6B payload for application decode
      const blePeerId = fromPeerId
        ? this.reverseMappings.get(fromPeerId)?.blePeerId
        : undefined;
      this.onLocalDeliver(packet.payload, blePeerId);
    };

    this.relayEngine = new RelayEngine({
      localNodeId: this.localNodeId,
      router: this.meshRouter,
      dedupCache: this.dedupCache,
      sendToPeer,
      deliver,
    });
  }

  // ── Peer Management ──────────────────────────────────────────

  /**
   * Register a BLE peer with its BITCHAT node ID.
   * Called only for DIRECT BLE connections (via ANNOUNCE exchange).
   */
  registerPeer(blePeerId: string, bitchatNodeId: NodeId): void {
    const normalized = normalizeNodeId(bitchatNodeId);

    // Keep both indexes bijective. ANNOUNCE is connection-scoped and may be
    // repeated after reconnect; leaving either old reverse entry alive can
    // route a logical destination to a BLE key that is no longer connected.
    const previousForBle = this.peerMappings.get(blePeerId);
    if (previousForBle && previousForBle.bitchatNodeId !== normalized) {
      this.reverseMappings.delete(previousForBle.bitchatNodeId);
      this.peerRegistry.markDisconnected(previousForBle.bitchatNodeId);
    }
    const previousForNode = this.reverseMappings.get(normalized);
    if (previousForNode && previousForNode.blePeerId !== blePeerId) {
      this.peerMappings.delete(previousForNode.blePeerId);
      this.peerRegistry.markDisconnected(normalized);
    }

    const mapping: PeerMapping = { blePeerId, bitchatNodeId: normalized };
    this.peerMappings.set(blePeerId, mapping);
    this.reverseMappings.set(normalized, mapping);

    this.peerRegistry.markConnected(normalized);
    console.log(`[BitChatAdapter] Peer registered: ${blePeerId} → ${normalized}`);
  }

  /**
   * Mark a BLE peer as disconnected.
   * The peer remains in PeerRegistry as DISCOVERED (not removed).
   */
  unregisterPeer(blePeerId: string): void {
    const mapping = this.peerMappings.get(blePeerId);
    if (mapping) {
      this.peerRegistry.markDisconnected(mapping.bitchatNodeId);
      this.peerMappings.delete(blePeerId);
      // Delete only the reverse entry that still points at this connection.
      // A newer reconnect may already have replaced it.
      const reverse = this.reverseMappings.get(mapping.bitchatNodeId);
      if (reverse?.blePeerId === blePeerId) {
        this.reverseMappings.delete(mapping.bitchatNodeId);
      }
      console.log(`[BitChatAdapter] Peer disconnected: ${blePeerId}`);
    }
  }

  getNodeIdForBlePeer(blePeerId: string): NodeId | undefined {
    return this.peerMappings.get(blePeerId)?.bitchatNodeId;
  }

  getBlePeerForNodeId(nodeId: NodeId): string | undefined {
    return this.reverseMappings.get(normalizeNodeId(nodeId))?.blePeerId;
  }

  /** Return the native BLE keys currently represented in the direct map. */
  getDirectBlePeerIds(): string[] {
    return Array.from(this.peerMappings.keys());
  }

  /**
   * Return true only when this exact BLE key has a live direct BITCHAT route.
   * The route is ready only after ANNOUNCE registered a bijective BLE↔NodeId
   * mapping and the corresponding PeerRegistry entry is CONNECTED.
   */
  isDirectPeerReady(blePeerId: string): boolean {
    const mapping = this.peerMappings.get(blePeerId);
    if (!mapping) return false;
    const reverse = this.reverseMappings.get(mapping.bitchatNodeId);
    if (reverse?.blePeerId !== blePeerId) return false;
    return this.peerRegistry.getPeer(mapping.bitchatNodeId)?.state === 'CONNECTED';
  }

  // ── ANNOUNCE ─────────────────────────────────────────────────

  /**
   * Create an ANNOUNCE BITCHAT packet containing the local node ID.
   * The caller should send the encoded packet over BLE.
   *
   * @returns Encoded ANNOUNCE BITCHAT packet.
   */
  createAnnouncePacket(): Uint8Array {
    const payload = encodeAnnounce(this.localNodeId);
    const packet: BitChatPacket = {
      version: PROTOCOL_VERSION,
      packetType: PACKET_TYPE_ANNOUNCE,
      ttl: DEFAULT_TTL,
      sourceNodeId: this.localNodeId,
      destinationNodeId: NODE_ID_BROADCAST,
      packetId: normalizeNodeId(BigInt(Date.now()) ^ BigInt('0x' + this.localNodeId.slice(2))),
      flags: FLAGS_NONE,
      payload,
    };
    return bitChatEncode(packet);
  }

  /**
   * Process a received ANNOUNCE packet.
   * Extracts the remote node ID and registers the peer mapping.
   *
   * @param announcePayload  The 9-byte ANNOUNCE payload.
   * @param blePeerId        The BLE peer identifier.
   * @returns The remote NodeId if successful, null otherwise.
   */
  processAnnounce(announcePayload: Uint8Array, blePeerId: string): NodeId | null {
    const remoteNodeId = safeDecodeAnnounce(announcePayload);
    if (!remoteNodeId) {
      return null;
    }
    const isNewPeer = !this.peerMappings.has(blePeerId);
    this.registerPeer(blePeerId, remoteNodeId);
    // V9E-announce-heal: let the integration layer answer with its own
    // ANNOUNCE (bounded retry in the hook) so registration is symmetric
    // even when the peer's connection-time ANNOUNCE was lost (e.g. sent
    // before notifications/CCCD were ready). Duplicate ANNOUNCEs are
    // harmless: registerPeer is idempotent for the same mapping.
    if (isNewPeer && this.onAnnounceReceived) {
      try {
        this.onAnnounceReceived(blePeerId, remoteNodeId);
      } catch {
        // Callback errors must never break packet processing.
      }
    }
    return remoteNodeId;
  }

  // ── DISCOVERY (V9D) ──────────────────────────────────────────

  /**
   * Create a DISCOVERY BITCHAT packet advertising the local node's identity.
   * The caller should send the encoded packet over BLE for mesh flooding.
   *
   * @returns Encoded DISCOVERY BITCHAT packet.
   */
  createDiscoveryPacket(): Uint8Array {
    const payload = encodeDiscovery(this.localNodeId);
    const packet: BitChatPacket = {
      version: PROTOCOL_VERSION,
      packetType: PACKET_TYPE_DISCOVERY,
      ttl: DEFAULT_TTL,
      sourceNodeId: this.localNodeId,
      destinationNodeId: NODE_ID_BROADCAST,
      packetId: normalizeNodeId(BigInt(Date.now()) ^ BigInt('0x' + this.localNodeId.slice(2)) ^ BigInt(0xD)),
      flags: FLAGS_NONE,
      payload,
    };
    return bitChatEncode(packet);
  }

  /**
   * Process a received DISCOVERY packet.
   * Extracts the advertised Node ID and records it in the discovery registry.
   * Does NOT modify the direct BLE peer mapping.
   *
   * @param discoveryPayload  The 9-byte DISCOVERY payload.
   * @param fromPeerId        The BLE peer that sent this packet (optional).
   * @returns The advertised NodeId if successful, null otherwise.
   */
  processDiscovery(discoveryPayload: Uint8Array, fromPeerId?: NodeId): NodeId | null {
    const advertisedNodeId = safeDecodeDiscovery(discoveryPayload);
    if (!advertisedNodeId) {
      return null;
    }

    // Record in the mesh discovery registry.
    // This does NOT create a direct BLE peer mapping.
    // The hopCount is estimated from whether we have a direct peer mapping.
    const hopCount = fromPeerId && this.reverseMappings.has(fromPeerId) ? 1 : 0;
    this.discoveryRegistry.record(advertisedNodeId, hopCount, fromPeerId);

    console.log(`[BitChatAdapter] Discovered node: ${advertisedNodeId} (hop ${hopCount})`);
    return advertisedNodeId;
  }

  /**
   * Get all recently discovered mesh nodes.
   *
   * @returns Array of DiscoveredNode records.
   */
  getDiscoveredNodes() {
    return this.discoveryRegistry.getAll();
  }

  /**
   * Check if a node ID is a directly connected BLE peer
   * (as opposed to a mesh-discovered remote node).
   *
   * @returns true if the node has a direct BLE peer mapping.
   */
  isDirectPeer(nodeId: NodeId): boolean {
    return this.reverseMappings.has(normalizeNodeId(nodeId));
  }

  // ── Receive Path ─────────────────────────────────────────────

  /**
   * Process incoming BITCHAT data.
   *
   * - ANNOUNCE: processed locally for direct peer identity (never relayed)
   * - DISCOVERY: recorded in MeshDiscoveryRegistry, then forwarded via RelayEngine
   * - DATA: delivered if addressed, forwarded via RelayEngine
   *
   * @param rawData    The raw BITCHAT envelope bytes.
   * @param blePeerId  The BLE peer identifier.
   * @returns 'announce' | 'discovery' | 'data' | null
   */
  async receive(rawData: Uint8Array, blePeerId: string): Promise<'announce' | 'discovery' | 'data' | null> {
    if (rawData.length < BITCHAT_HEADER_SIZE || rawData[0] !== PROTOCOL_VERSION) {
      return null;
    }

    const packet = bitChatSafeDecode(rawData);
    if (!packet) {
      return null;
    }

    // V9C: ANNOUNCE is direct-link-only. Process locally, never relay.
    if (packet.packetType === PACKET_TYPE_ANNOUNCE) {
      this.processAnnounce(packet.payload, blePeerId);
      return 'announce';
    }

    // V9D: DISCOVERY is mesh-flooded like DATA.
    // Process locally (record in discovery registry), then forward via RelayEngine.
    if (packet.packetType === PACKET_TYPE_DISCOVERY) {
      const fromNodeId = this.getNodeIdForBlePeer(blePeerId);
      this.processDiscovery(packet.payload, fromNodeId);

      // Forward through RelayEngine (controlled flooding with TTL)
      await this.relayEngine.receive(packet, fromNodeId);
      return 'discovery';
    }

    // DATA: resolve BLE peer → BITCHAT NodeId, route through RelayEngine
    const fromNodeId = this.getNodeIdForBlePeer(blePeerId);
    if (fromNodeId) {
      this.peerRegistry.markSeen(fromNodeId);
    }

    await this.relayEngine.receive(packet, fromNodeId);
    return 'data';
  }

  // ── Originate Path ───────────────────────────────────────────

  /**
   * Originate a locally-produced payload as a BITCHAT DATA packet.
   */
  async originate(
    payload: Uint8Array,
    packetId: PacketId,
    destinationNodeId: NodeId = NODE_ID_BROADCAST,
    ttl: number = DEFAULT_TTL,
  ): Promise<number> {
    this.originatedPacketId = packetId;

    const packet: BitChatPacket = {
      version: PROTOCOL_VERSION,
      packetType: PACKET_TYPE_DATA,
      ttl,
      sourceNodeId: this.localNodeId,
      destinationNodeId,
      packetId,
      flags: FLAGS_NONE,
      payload,
    };

    return await this.relayEngine.originate(packet);
  }

  /**
   * Originate a DISCOVERY packet to advertise this node's identity across the mesh.
   */
  async originateDiscovery(ttl: number = DEFAULT_TTL): Promise<void> {
    const payload = encodeDiscovery(this.localNodeId);
    const packetId = normalizeNodeId(
      BigInt(Date.now()) ^ BigInt('0x' + this.localNodeId.slice(2)) ^ BigInt(0xD),
    );

    const packet: BitChatPacket = {
      version: PROTOCOL_VERSION,
      packetType: PACKET_TYPE_DISCOVERY,
      ttl,
      sourceNodeId: this.localNodeId,
      destinationNodeId: NODE_ID_BROADCAST,
      packetId,
      flags: FLAGS_NONE,
      payload,
    };

    await this.relayEngine.originate(packet);
  }

  // ── Utilities ────────────────────────────────────────────────

  getConnectedPeers(): NodeId[] {
    return this.peerRegistry.getPeers()
      .filter(p => p.state === 'CONNECTED')
      .map(p => p.peerId);
  }

  getLocalNodeId(): NodeId {
    return this.localNodeId;
  }
}
