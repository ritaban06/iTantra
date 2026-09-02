/**
 * V9D BitChat Mesh Discovery Registry
 *
 * Tracks BITCHAT nodes discovered through multi-hop mesh flooding.
 * This is NOT a routing table — it only records "which nodes exist."
 *
 * Requirements:
 * - Injectable clock for deterministic testing
 * - Bounded size with oldest-eviction
 * - Expiry/TTL for discovery records
 * - Normalized Node IDs
 * - Duplicate-safe: rediscovery refreshes existing entries
 */

import { DISCOVERY_MAX_ENTRIES, DISCOVERY_RETENTION_MS } from '../core/BitChatConstants';
import { normalizeNodeId } from '../core/BitChatPacket';
import type { NodeId } from '../core/BitChatTypes';

type ClockFn = () => number;

/** A single discovered-node record. */
export interface DiscoveredNode {
  /** The discovered node's BITCHAT identity. */
  nodeId: NodeId;
  /** When this node was first discovered (or last refreshed). */
  discoveredAt: number;
  /**
   * Approximate hop count from the discovering node.
   * NON-AUTHORITATIVE: this is advisory metadata only.
   * It is inferred from whether the reporting peer is a direct BLE peer
   * and must NOT be used for routing or destination decisions.
   * 0 = direct BLE peer, 1+ = discovered through mesh flooding.
   */
  hopCount: number;
  /** The BLE peer that first reported this node (optional). */
  reportedBy?: NodeId;
}

/**
 * Bounded, expiring registry for mesh-discovered nodes.
 *
 * Only answers: "Which BITCHAT nodes have been discovered recently?"
 * Does NOT provide routing information.
 * hopCount is non-authoritative advisory metadata only.
 */
export class MeshDiscoveryRegistry {
  /** Discovered nodes keyed by normalized NodeId. */
  private nodes = new Map<NodeId, DiscoveredNode>();

  /** Maximum entries. */
  private maxEntries: number;

  /** Retention time in milliseconds. */
  private retentionMs: number;

  /** Injected clock function. */
  private now: ClockFn;

  /**
   * @param maxEntries   Maximum discovery entries (default: 128).
   * @param retentionMs  Entry retention in ms (default: 120,000).
   * @param clockFn      Optional clock function (default: Date.now).
   */
  constructor(
    maxEntries: number = DISCOVERY_MAX_ENTRIES,
    retentionMs: number = DISCOVERY_RETENTION_MS,
    clockFn?: ClockFn,
  ) {
    this.maxEntries = maxEntries;
    this.retentionMs = retentionMs;
    this.now = clockFn ?? (() => Date.now());
  }

/**
 * Record a discovered node.
 * If the node already exists, refreshes its timestamp and hop count
 * (only if the new hop count is shorter).
 *
 * hopCount is NON-AUTHORITATIVE advisory metadata. It must NOT be
 * used for routing, destination selection, or delivery decisions.
 *
 * @param nodeId     The discovered node's BITCHAT identity.
 * @param hopCount   Approximate hop distance (advisory only, not for routing).
 * @param reportedBy The BLE peer that reported this node (optional).
 */
  record(nodeId: NodeId, hopCount: number, reportedBy?: NodeId): void {
    const normalized = normalizeNodeId(nodeId);
    const ts = this.now();
    const existing = this.nodes.get(normalized);

    if (existing) {
      // Refresh: update timestamp, and use shorter hop count
      existing.discoveredAt = ts;
      if (hopCount < existing.hopCount) {
        existing.hopCount = hopCount;
        existing.reportedBy = reportedBy;
      }
      return;
    }

    // New entry
    const record: DiscoveredNode = {
      nodeId: normalized,
      discoveredAt: ts,
      hopCount,
      reportedBy: reportedBy ? normalizeNodeId(reportedBy) : undefined,
    };

    this.nodes.set(normalized, record);

    // Evict oldest if over capacity
    if (this.nodes.size > this.maxEntries) {
      this.evictOldest();
    }
  }

  /**
   * Check if a node has been discovered.
   *
   * @returns true if the node is in the registry and not expired.
   */
  has(nodeId: NodeId): boolean {
    const normalized = normalizeNodeId(nodeId);
    const entry = this.nodes.get(normalized);
    if (!entry) return false;

    // Check expiry
    if (this.now() - entry.discoveredAt > this.retentionMs) {
      this.nodes.delete(normalized);
      return false;
    }

    return true;
  }

  /**
   * Get a discovered node's information.
   *
   * @returns The DiscoveredNode, or undefined if not found or expired.
   */
  get(nodeId: NodeId): DiscoveredNode | undefined {
    const normalized = normalizeNodeId(nodeId);
    const entry = this.nodes.get(normalized);
    if (!entry) return undefined;

    // Check expiry
    if (this.now() - entry.discoveredAt > this.retentionMs) {
      this.nodes.delete(normalized);
      return undefined;
    }

    return entry;
  }

  /**
   * Get all non-expired discovered nodes.
   *
   * @returns Array of DiscoveredNode records.
   */
  getAll(): DiscoveredNode[] {
    this.pruneExpired();
    return Array.from(this.nodes.values());
  }

  /**
   * Remove expired entries.
   *
   * @returns Number of entries removed.
   */
  pruneExpired(): number {
    const cutoff = this.now() - this.retentionMs;
    let count = 0;
    for (const [key, entry] of this.nodes) {
      if (entry.discoveredAt < cutoff) {
        this.nodes.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.nodes.clear();
  }

  /**
   * Get the current number of entries (for testing).
   */
  getCount(): number {
    return this.nodes.size;
  }

  // ── Internal ──────────────────────────────────────────────────

  /**
   * Evict the oldest entry (earliest discoveredAt).
   */
  private evictOldest(): void {
    let oldestKey: NodeId | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.nodes) {
      if (entry.discoveredAt < oldestTime) {
        oldestTime = entry.discoveredAt;
        oldestKey = key;
      }
    }

    if (oldestKey !== null) {
      this.nodes.delete(oldestKey);
    }
  }
}
