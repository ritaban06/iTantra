/**
 * V8 Completed Group Cache
 *
 * Per-peer cache of successfully completed V7 reassembly groups.
 * Prevents duplicate V7 reassembly and TTS when retransmitted
 * fragments arrive after successful reassembly.
 *
 * When a V7 fragment arrives for a completed group:
 *   - Do NOT recreate reassembly state
 *   - Do NOT re-deliver the message
 *   - DO regenerate ACK using the cached messageId
 */

import {
  COMPLETED_CACHE_MAX,
  COMPLETED_CACHE_RETENTION_MS,
  CompletedGroupEntry,
} from './ReliabilityTypes';

export class CompletedGroupCache {
  /** Per-peer caches. Key = sourceId. */
  private caches = new Map<string, CompletedGroupEntry[]>();

  /**
   * Check if a V7 group was already completed for this peer.
   *
   * @param sourceId  Peer device identifier.
   * @param groupId   V7 group identifier.
   * @returns The cached messageId if completed, or null.
   */
  getCompletedMessageId(sourceId: string, groupId: number): string | null {
    const entries = this.caches.get(sourceId);
    if (!entries) return null;

    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].groupId === groupId) {
        return entries[i].messageId;
      }
    }
    return null;
  }

  /**
   * Check if a group was already completed.
   *
   * @param sourceId  Peer device identifier.
   * @param groupId   V7 group identifier.
   * @returns true if the group was already completed.
   */
  isCompleted(sourceId: string, groupId: number): boolean {
    return this.getCompletedMessageId(sourceId, groupId) !== null;
  }

  /**
   * Record that a V7 group was successfully completed and delivered.
   *
   * @param sourceId  Peer device identifier.
   * @param groupId   V7 group identifier.
   * @param messageId V6A messageId (for ACK regeneration).
   */
  store(sourceId: string, groupId: number, messageId: string): void {
    let entries = this.caches.get(sourceId);
    if (!entries) {
      entries = [];
      this.caches.set(sourceId, entries);
    }

    // Evict oldest if at capacity.
    if (entries.length >= COMPLETED_CACHE_MAX) {
      entries.shift();
    }

    entries.push({
      groupId,
      messageId,
      completedAt: Date.now(),
    });
  }

  /**
   * Remove expired entries for a peer.
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
      if (now - entries[i].completedAt > COMPLETED_CACHE_RETENTION_MS) {
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
