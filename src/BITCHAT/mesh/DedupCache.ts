/**
 * V9A BitChat Dedup Cache
 *
 * Bounded, expiring cache for network packet deduplication.
 * Key: sourceNodeId + packetId (normalized).
 * Separate from V8 DeliveredMessageCache / CompletedGroupCache.
 *
 * Uses an injectable clock for deterministic testing.
 */

import { DEDUP_MAX_ENTRIES, DEDUP_RETENTION_MS } from '../core/BitChatConstants';
import { normalizeNodeId, normalizePacketId } from '../core/BitChatPacket';
import type { NodeId, PacketId } from '../core/BitChatTypes';

type ClockFn = () => number;

interface CacheEntry {
  /** Composite key: "sourceNodeId:packetId". */
  key: string;
  /** Timestamp when this entry was created. */
  seenAt: number;
}

export class DedupCache {
  /** Bounded list of cache entries. */
  private entries: CacheEntry[] = [];

  /** Maximum entries. */
  private maxEntries: number;

  /** Retention time in milliseconds. */
  private retentionMs: number;

  /** Injected clock function. */
  private now: ClockFn;

  /**
   * @param maxEntries   Maximum cache entries (default: 256).
   * @param retentionMs  Entry retention in ms (default: 60,000).
   * @param clockFn      Optional clock function (default: Date.now).
   */
  constructor(
    maxEntries: number = DEDUP_MAX_ENTRIES,
    retentionMs: number = DEDUP_RETENTION_MS,
    clockFn?: ClockFn,
  ) {
    this.maxEntries = maxEntries;
    this.retentionMs = retentionMs;
    this.now = clockFn ?? (() => Date.now());
  }

  /**
   * Check if a packet has been seen before.
   * Does NOT mark it as seen.
   *
   * @returns true if the packet was previously seen.
   */
  has(sourceNodeId: NodeId, packetId: PacketId): boolean {
    const key = this.buildKey(sourceNodeId, packetId);
    return this.entries.some(e => e.key === key);
  }

  /**
   * Mark a packet as seen (without checking first).
   */
  markSeen(sourceNodeId: NodeId, packetId: PacketId): void {
    const key = this.buildKey(sourceNodeId, packetId);
    const ts = this.now();

    // Remove existing entry with same key if present (to update timestamp)
    this.entries = this.entries.filter(e => e.key !== key);

    this.entries.push({ key, seenAt: ts });

    // Evict oldest if over capacity
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }

  /**
   * Atomically check if a packet was seen and mark it as seen.
   *
   * @returns true if the packet was a DUPLICATE (already seen).
   *          false if this is the FIRST occurrence.
   */
  checkAndMark(sourceNodeId: NodeId, packetId: PacketId): boolean {
    const key = this.buildKey(sourceNodeId, packetId);
    const ts = this.now();

    // Check existing
    const existing = this.entries.find(e => e.key === key);
    if (existing) {
      return true; // Duplicate
    }

    // First occurrence — mark it
    this.entries.push({ key, seenAt: ts });

    // Evict oldest if over capacity
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }

    return false; // Not a duplicate
  }

  /**
   * Remove expired entries.
   *
   * @returns Number of entries removed.
   */
  pruneExpired(): number {
    const cutoff = this.now() - this.retentionMs;
    const before = this.entries.length;
    this.entries = this.entries.filter(e => e.seenAt >= cutoff);
    return before - this.entries.length;
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.entries = [];
  }

  /**
   * Get the current number of entries (for testing).
   */
  getCount(): number {
    return this.entries.length;
  }

  // ── Internal ──────────────────────────────────────────────────

  /**
   * Build a composite key from sourceNodeId and packetId.
   * Both are normalized before key construction.
   */
  private buildKey(sourceNodeId: NodeId, packetId: PacketId): string {
    return `${normalizeNodeId(sourceNodeId)}:${normalizePacketId(packetId)}`;
  }
}
