/**
 * V9C BitChat ↔ BLE Adapter
 *
 * Integration bridge between the existing BLE transport (V6B/V8)
 * and the BITCHAT mesh layer (V9A/V9B/V9C).
 *
 * Responsibilities:
 * - Detect incoming BITCHAT packets from BLE data
 * - Route BITCHAT packets through RelayEngine (destination-aware)
 * - Map BLE peer IDs to BITCHAT node IDs via ANNOUNCE exchange
 * - Originate BITCHAT packets from local payloads (with destinationNodeId)
 * - Forward RelayEngine-eligible packets through V6B/V8
 * - Deliver locally-recovered payloads for application decode
 * - Skip local delivery for self-originated packets (relay-only behavior)
 *
 * V9C changes:
 * - originate() accepts destinationNodeId for unicast delivery
 * - RelayEngine handles destination-aware delivery (only delivered if addressed)
 * - BITCHAT packets are sent through V6B for per-hop transport reliability
 *
 * Does NOT:
 * - Import NativeBLE (transport-agnostic)
 * - Redesign V6A/V6B/V7/V8 protocols
 * - Implement link reliability (V8 handles that per hop)
 * - Implement STT/TTS (useBLEVoiceMode handles that)
 */

import { normalizeNodeId } from './core/BitChatPacket';
import { safeDecode as bitChatSafeDecode, encode as bitChatEncode } from './core/BitChatPacketCodec';
import {
  PROTOCOL_VERSION,
  HEADER_SIZE as BITCHAT_HEADER_SIZE,
  DEFAULT_TTL,
  PACKET_TYPE_DATA,
  PACKET_TYPE_ANNOUNCE,
  FLAGS_NONE,
  NODE_ID_BROADCAST,
} from './core/BitChatConstants';
import type { BitChatPacket, NodeId, PacketId } from './core/BitChatTypes';
import { encodeAnnounce, safeDecodeAnnounce } from './AnnounceCodec';
import { RelayEngine } from './mesh/RelayEngine';
import { MeshRouter } from './mesh/MeshRouter';
import { DedupCache } from './mesh/DedupCache';
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
}

/** Mapping from BITCHAT NodeId to BLE peer ID string. */
interface PeerMapping {
  blePeerId: string;
  bitchatNodeId: NodeId;
}

// ── Adapter ──────────────────────────────────────────────────────

export class BitChatBLEAdapter {
  private readonly localNodeId: NodeId;
  private readonly bleSend: BleSendFn;
  private readonly onLocalDeliver: LocalDeliverFn;

  /** BITCHAT mesh components. */
  readonly peerRegistry: PeerRegistry;
  readonly dedupCache: DedupCache;
  readonly meshRouter: MeshRouter;
  readonly relayEngine: RelayEngine;

  /** BLE peer ID ↔ BITCHAT NodeId mapping. */
  private peerMappings = new Map<string, PeerMapping>();
  private reverseMappings = new Map<NodeId, PeerMapping>();

  /**
   * Packet ID of the last originated packet.
   * Used to suppress local delivery for self-originated packets
   * (the originator already processed the speech locally).
   */
  private originatedPacketId: PacketId | null = null;

  constructor(params: BitChatBLEAdapterParams) {
    this.localNodeId = normalizeNodeId(params.localNodeId);
    this.bleSend = params.bleSend;
    this.onLocalDeliver = params.onLocalDeliver;

    // Initialize BITCHAT mesh components
    this.peerRegistry = new PeerRegistry();
    this.dedupCache = new DedupCache();
    this.meshRouter = new MeshRouter(this.localNodeId, this.peerRegistry);

    // sendToPeer: maps BITCHAT NodeId → BLE peer ID → bleSend
    const sendToPeer = async (peerId: NodeId, packet: BitChatPacket): Promise<void> => {
      const mapping = this.reverseMappings.get(peerId);
      if (!mapping) {
        console.warn(`[BitChatAdapter] No BLE mapping for peer ${peerId}`);
        return;
      }
      const encoded = bitChatEncode(packet);
      await this.bleSend(mapping.blePeerId, encoded);
    };

    // deliver: called by RelayEngine for first-seen packets addressed to this node
    const deliver = (packet: BitChatPacket, fromPeerId?: NodeId): void => {
      if (packet.packetType !== PACKET_TYPE_DATA) {
        return; // ANNOUNCE: consumed at mesh layer, not delivered to application
      }

      // Skip local delivery for self-originated packets.
      // The originator already processed the speech locally (STT → TTS).
      if (this.originatedPacketId !== null && packet.packetId === this.originatedPacketId) {
        this.originatedPacketId = null; // consumed
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
   * Called when a BLE connection is established and the remote peer's
   * node ID is known (e.g. via an ANNOUNCE exchange).
   */
  registerPeer(blePeerId: string, bitchatNodeId: NodeId): void {
    const normalized = normalizeNodeId(bitchatNodeId);

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
      this.reverseMappings.delete(mapping.bitchatNodeId);
      console.log(`[BitChatAdapter] Peer disconnected: ${blePeerId}`);
    }
  }

  getNodeIdForBlePeer(blePeerId: string): NodeId | undefined {
    return this.peerMappings.get(blePeerId)?.bitchatNodeId;
  }

  getBlePeerForNodeId(nodeId: NodeId): string | undefined {
    return this.reverseMappings.get(normalizeNodeId(nodeId))?.blePeerId;
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
   * @param announcePayload  The 9-byte ANNOUNCE payload (from inside a BITCHAT packet).
   * @param blePeerId        The BLE peer identifier.
   * @returns The remote NodeId if successful, null otherwise.
   */
  processAnnounce(announcePayload: Uint8Array, blePeerId: string): NodeId | null {
    const remoteNodeId = safeDecodeAnnounce(announcePayload);
    if (!remoteNodeId) {
      return null;
    }
    this.registerPeer(blePeerId, remoteNodeId);
    return remoteNodeId;
  }

  // ── Receive Path ─────────────────────────────────────────────

  /**
   * Process incoming BLE data that has been identified as a BITCHAT envelope.
   *
   * Routes through RelayEngine for destination-aware delivery and forwarding.
   *
   * @param rawData    The raw BITCHAT envelope bytes (after V6B unwrap if applicable).
   * @param blePeerId  The BLE peer identifier.
   * @returns 'announce' | 'data' | null (null = not valid BITCHAT)
   */
  async receive(rawData: Uint8Array, blePeerId: string): Promise<'announce' | 'data' | null> {
    if (rawData.length < BITCHAT_HEADER_SIZE || rawData[0] !== PROTOCOL_VERSION) {
      return null;
    }

    const packet = bitChatSafeDecode(rawData);
    if (!packet) {
      return null;
    }

    // V9C: ANNOUNCE is a direct-link-only control packet.
    // It must NEVER be relayed through the mesh. Processing it here
    // ensures the BLE peer ID ↔ node ID mapping uses the DIRECTLY
    // connected peer, not an intermediate relay node.
    if (packet.packetType === PACKET_TYPE_ANNOUNCE) {
      this.processAnnounce(packet.payload, blePeerId);
      return 'announce';
    }

    // DATA packets: resolve BLE peer → BITCHAT NodeId
    const fromNodeId = this.getNodeIdForBlePeer(blePeerId);
    if (fromNodeId) {
      this.peerRegistry.markSeen(fromNodeId);
    }

    // Route DATA through RelayEngine (destination-aware delivery + forwarding)
    await this.relayEngine.receive(packet, fromNodeId);

    return 'data';
  }

  // ── Originate Path ───────────────────────────────────────────

  /**
   * Originate a locally-produced payload as a BITCHAT DATA packet.
   *
   * @param payload          The V6B payload to send.
   * @param packetId         Unique packet identifier.
   * @param destinationNodeId  Target node (or NODE_ID_BROADCAST for broadcast).
   * @param ttl              Optional TTL override (default: DEFAULT_TTL).
   */
  async originate(
    payload: Uint8Array,
    packetId: PacketId,
    destinationNodeId: NodeId = NODE_ID_BROADCAST,
    ttl: number = DEFAULT_TTL,
  ): Promise<void> {
    // Track originated packet to suppress self-delivery
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
