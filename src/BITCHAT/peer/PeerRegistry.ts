/**
 * V9A BitChat Peer Registry
 *
 * Lightweight in-memory registry for tracking known BLE peers.
 * No platform-specific code — pure data structure.
 */

import { PEER_STALE_THRESHOLD_MS } from '../core/BitChatConstants';
import { normalizeNodeId } from '../core/BitChatPacket';
import type { NodeId } from '../core/BitChatTypes';
import type { PeerInfo, PeerState } from './PeerTypes';

/**
 * Clock abstraction for testability.
 * Returns the current timestamp in milliseconds.
 */
type ClockFn = () => number;

export class PeerRegistry {
  /** Peer entries keyed by normalized NodeId. */
  private peers = new Map<NodeId, PeerInfo>();

  /** Stale threshold in milliseconds. */
  private staleThresholdMs: number;

  /** Injected clock function. */
  private now: ClockFn;

  /**
   * @param staleThresholdMs  Milliseconds after which a peer is considered stale.
   * @param clockFn           Optional clock function (default: Date.now).
   */
  constructor(staleThresholdMs: number = PEER_STALE_THRESHOLD_MS, clockFn?: ClockFn) {
    this.staleThresholdMs = staleThresholdMs;
    this.now = clockFn ?? (() => Date.now());
  }

  /**
   * Add or update a peer. If the peer already exists, updates lastSeen.
   *
   * @param peerId  The peer's NodeId.
   * @param rssi    Optional RSSI value.
   * @returns The PeerInfo record.
   */
  upsertPeer(peerId: NodeId, rssi?: number): PeerInfo {
    const id = normalizeNodeId(peerId);
    const existing = this.peers.get(id);
    const ts = this.now();

    if (existing) {
      existing.lastSeen = ts;
      if (rssi !== undefined) {
        existing.rssi = rssi;
      }
      return existing;
    }

    const info: PeerInfo = {
      peerId: id,
      lastSeen: ts,
      rssi,
      state: 'DISCOVERED',
    };
    this.peers.set(id, info);
    return info;
  }

  /**
   * Get a peer by ID.
   *
   * @returns The PeerInfo, or undefined if not found.
   */
  getPeer(peerId: NodeId): PeerInfo | undefined {
    return this.peers.get(normalizeNodeId(peerId));
  }

  /**
   * Get all known peers.
   *
   * @returns Array of all PeerInfo records.
   */
  getPeers(): PeerInfo[] {
    return Array.from(this.peers.values());
  }

  /**
   * Update lastSeen for an existing peer.
   * If the peer does not exist, creates it in DISCOVERED state.
   */
  markSeen(peerId: NodeId, rssi?: number): void {
    this.upsertPeer(peerId, rssi);
  }

  /**
   * Mark a peer as CONNECTED.
   * Updates lastSeen. Creates the peer if it does not exist.
   */
  markConnected(peerId: NodeId): void {
    const info = this.upsertPeer(peerId);
    info.state = 'CONNECTED';
  }

  /**
   * Mark a peer as DISCONNECTED (state → DISCOVERED).
   * Updates lastSeen. Creates the peer if it does not exist.
   */
  markDisconnected(peerId: NodeId): void {
    const info = this.upsertPeer(peerId);
    info.state = 'DISCOVERED';
  }

  /**
   * Prune peers whose lastSeen is older than the stale threshold.
   * Does NOT automatically delete — only marks as STALE.
   * Call removePeer() explicitly to delete.
   *
   * @returns Number of peers marked as STALE.
   */
  pruneStale(): number {
    const threshold = this.now() - this.staleThresholdMs;
    let count = 0;
    for (const peer of this.peers.values()) {
      if (peer.lastSeen < threshold && peer.state !== 'STALE') {
        peer.state = 'STALE';
        count++;
      }
    }
    return count;
  }

  /**
   * Remove a peer from the registry.
   *
   * @returns true if the peer was found and removed.
   */
  removePeer(peerId: NodeId): boolean {
    return this.peers.delete(normalizeNodeId(peerId));
  }

  /**
   * Remove all peers from the registry.
   */
  clear(): void {
    this.peers.clear();
  }
}
