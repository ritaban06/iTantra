/**
 * V8 Delivered Message Cache
 *
 * Per-peer LRU cache of successfully delivered V6A messageIds.
 * Prevents duplicate semantic delivery (TTS) when retransmitted
 * DATA frames arrive after successful delivery.
 *
 * Also supports ACK regeneration: if a retransmitted frame arrives
 * for an already-delivered message, the cache enables re-sending
 * the ACK without re-delivering the semantic content.
 */

import {
  DELIVERED_CACHE_MAX,
  DELIVERED_CACHE_RETENTION_MS,
  DeliveredEntry,
} from './ReliabilityTypes';

export class DeliveredMessageCache {
  /** Per-peer caches. Key = sourceId. */
  private caches = new Map<string, DeliveredEntry[]>();

  /**
   * Check if a messageId was already delivered for this peer.
   *
   * @param sourceId   Peer device identifier.
   * @param messageId  V6A messageId hash string.
   * @returns true if already delivered.
   */
  isDelivered(sourceId: string, messageId: string): boolean {
    const entries = this.caches.get(sourceId);
    if (!entries) return false;

    // Check from most recent (end of array) for LRU efficiency.
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].messageId === messageId) {
        return true;
      }
    }
    return false;
  }

  /**
   * Record that a messageId was successfully delivered.
   * Called after semantic acceptance (decode success + before or after TTS).
   *
   * @param sourceId   Peer device identifier.
   * @param messageId  V6A messageId hash string.
   */
  markDelivered(sourceId: string, messageId: string): void {
    let entries = this.caches.get(sourceId);
    if (!entries) {
      entries = [];
      this.caches.set(sourceId, entries);
    }

    // Evict oldest if at capacity.
    if (entries.length >= DELIVERED_CACHE_MAX) {
      entries.shift();
    }

    entries.push({
      messageId,
      deliveredAt: Date.now(),
    });
  }

  /**
   * Remove expired entries for a peer.
   * Safe to call repeatedly.
   *
   * @param sourceId  Peer device identifier.
   * @returns Number of entries removed.
   */
  cleanup(sourceId: string): number {
    const entries = this.caches.get(sourceId);
    if (!entries) return 0;

    const now = Date.now();
    const before = entries.length;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (now - entries[i].deliveredAt > DELIVERED_CACHE_RETENTION_MS) {
        entries.splice(i, 1);
      }
    }
    return before - entries.length;
  }

  /**
   * Remove all entries for a peer.
   * Called on BLE disconnect.
   *
   * @param sourceId  Peer device identifier.
   */
  resetPeer(sourceId: string): void {
    this.caches.delete(sourceId);
  }

  /**
   * Get the number of entries for a peer (for testing/diagnostics).
   */
  getCount(sourceId: string): number {
    return this.caches.get(sourceId)?.length ?? 0;
  }
}
