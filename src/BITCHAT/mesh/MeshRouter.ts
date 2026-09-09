/**
 * V9B BitChat Mesh Router
 *
 * Determines which peers should receive a relayed packet.
 * For V9B: returns ALL connected peers except the incoming peer
 * and optionally the local node. No routing table, no shortest path.
 */

import { normalizeNodeId } from '../core/BitChatPacket';
import type { NodeId } from '../core/BitChatTypes';
import type { PeerInfo } from '../peer/PeerTypes';

/**
 * A minimal interface for the peer registry, used to query connected peers.
 * This avoids a direct import dependency on PeerRegistry.
 */
export interface PeerQuery {
  /** Get all known peers. */
  getPeers(): PeerInfo[];
}

export class MeshRouter {
  /** The local node's ID. */
  private readonly localNodeId: NodeId;

  /** Peer registry for querying connected peers. */
  private readonly peerQuery: PeerQuery;

  constructor(localNodeId: NodeId, peerQuery: PeerQuery) {
    this.localNodeId = normalizeNodeId(localNodeId);
    this.peerQuery = peerQuery;
  }

  /**
   * Get the list of peers that should receive a relayed packet.
   *
   * Returns all CONNECTED peers except:
   * - the incoming peer (to prevent immediate bounce-back)
   * - the local node (never relay to self)
   *
   * @param incomingPeerId  The peer that sent us this packet (optional for originated packets).
   * @returns Sorted array of NodeIds eligible for relay.
   */
  getRelayPeers(incomingPeerId?: NodeId): NodeId[] {
    const excluded = new Set<NodeId>();
    excluded.add(this.localNodeId);
    if (incomingPeerId) {
      excluded.add(normalizeNodeId(incomingPeerId));
    }

    const peers = this.peerQuery.getPeers();
    const eligible: NodeId[] = [];

    for (const peer of peers) {
      if (peer.state === 'CONNECTED' && !excluded.has(peer.peerId)) {
        eligible.push(peer.peerId);
      }
    }

    // Deterministic ordering: sort by hex string
    eligible.sort();
    return eligible;
  }
}
