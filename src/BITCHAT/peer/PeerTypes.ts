/**
 * V9A BitChat Peer Types
 */

import type { NodeId } from '../core/BitChatTypes';

/** Possible states for a peer in the registry. */
export type PeerState = 'DISCOVERED' | 'CONNECTED' | 'STALE';

/**
 * Information about a known peer.
 */
export interface PeerInfo {
  /** The peer's node identifier. */
  peerId: NodeId;

  /** Timestamp of the last time this peer was seen (ms). */
  lastSeen: number;

  /** Optional RSSI value from the last observation. */
  rssi?: number;

  /** Current connection state. */
  state: PeerState;
}
