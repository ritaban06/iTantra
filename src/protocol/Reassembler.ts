/**
 * V7 Reassembler — Stateful
 *
 * Collects V7 fragments from a source device and reconstructs
 * complete V6A binary packets.
 *
 * Responsibilities:
 *   - Accept fragments out of order
 *   - Handle duplicates safely
 *   - Enforce completion invariant (count + byte sum)
 *   - Expire incomplete groups after timeout
 *   - Limit concurrent groups
 *   - Validate metadata consistency
 *
 * Does NOT:
 *   - Generate outbound sequence numbers
 *   - Encode/decode V6B frames
 *   - Perform retransmission or ACK
 */

import {
  V7_HEADER_SIZE,
  MAX_FRAGMENTS,
  MAX_V6A_LENGTH,
  MAX_CONCURRENT_GROUPS,
  GROUP_EXPIRY_MS,
  MAX_GROUP_KEY_LENGTH,
  FragmentHeader,
  FragmentState,
  ReassemblyResult,
} from './V7FragmentTypes';

// ── Group Key ─────────────────────────────────────────────────────

function makeGroupKey(sourceId: string, groupId: number): string {
  const safeSource = sourceId.length > MAX_GROUP_KEY_LENGTH
    ? sourceId.slice(0, MAX_GROUP_KEY_LENGTH)
    : sourceId;
  return `${safeSource}:${groupId}`;
}

// ── Reassembler ───────────────────────────────────────────────────

export class Reassembler {
  private groups = new Map<string, FragmentState>();

  /**
   * Add a fragment to the reassembler.
   *
   * @param sourceId  Identifier of the sending device.
   * @param header    Parsed V7 fragment header.
   * @param payload   The V6A chunk bytes (everything after the 9-byte V7 header).
   * @returns Reassembly result.
   */
  addFragment(
    sourceId: string,
    header: FragmentHeader,
    payload: Uint8Array,
  ): ReassemblyResult {
    // ── Validate fragment basics ──────────────────────────────────
    if (header.totalFragments < 1 || header.totalFragments > MAX_FRAGMENTS) {
      return { status: 'error', reason: `Invalid totalFragments: ${header.totalFragments}` };
    }
    if (header.fragmentIndex >= header.totalFragments) {
      return { status: 'error', reason: `Invalid fragmentIndex: ${header.fragmentIndex}` };
    }
    if (header.v6aLength === 0 || header.v6aLength > MAX_V6A_LENGTH) {
      return { status: 'error', reason: `Invalid v6aLength: ${header.v6aLength}` };
    }

    const key = makeGroupKey(sourceId, header.groupId);
    let state = this.groups.get(key);

    // ── New group ─────────────────────────────────────────────────
    if (!state) {
      // Enforce concurrent group limit.
      if (this.groups.size >= MAX_CONCURRENT_GROUPS) {
        this.abortOldestGroup();
      }

      state = {
        sourceId,
        groupId: header.groupId,
        totalFragments: header.totalFragments,
        v6aLength: header.v6aLength,
        fragments: new Map(),
        receivedCount: 0,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      };
      this.groups.set(key, state);
    }

    // ── Validate metadata consistency ─────────────────────────────
    if (state.totalFragments !== header.totalFragments) {
      this.groups.delete(key);
      return { status: 'error', reason: `Conflicting totalFragments: expected ${state.totalFragments}, got ${header.totalFragments}` };
    }
    if (state.v6aLength !== header.v6aLength) {
      this.groups.delete(key);
      return { status: 'error', reason: `Conflicting v6aLength: expected ${state.v6aLength}, got ${header.v6aLength}` };
    }

    // ── Handle duplicate fragment ─────────────────────────────────
    if (state.fragments.has(header.fragmentIndex)) {
      // Duplicate — do not increment receivedCount, do not modify state.
      state.lastActivityAt = Date.now();
      return { status: 'incomplete' };
    }

    // ── Validate cumulative byte count ────────────────────────────
    let currentByteSum = 0;
    for (const frag of state.fragments.values()) {
      currentByteSum += frag.length;
    }
    if (currentByteSum + payload.length > state.v6aLength) {
      this.groups.delete(key);
      return { status: 'error', reason: `Cumulative bytes exceed v6aLength: ${currentByteSum + payload.length} > ${state.v6aLength}` };
    }

    // ── Store fragment ────────────────────────────────────────────
    state.fragments.set(header.fragmentIndex, payload);
    state.receivedCount++;
    state.lastActivityAt = Date.now();

    // ── Check completion ──────────────────────────────────────────
    if (state.receivedCount === state.totalFragments) {
      return this.tryComplete(state, key);
    }

    return { status: 'incomplete' };
  }

  /**
   * Attempt to finalize a group.
   */
  private tryComplete(state: FragmentState, key: string): ReassemblyResult {
    // Verify total byte count.
    let totalBytes = 0;
    for (const frag of state.fragments.values()) {
      totalBytes += frag.length;
    }
    if (totalBytes !== state.v6aLength) {
      this.groups.delete(key);
      return { status: 'error', reason: `Byte sum mismatch: ${totalBytes} !== ${state.v6aLength}` };
    }

    // Sort fragments by index and concatenate.
    const sortedIndices = Array.from(state.fragments.keys()).sort((a, b) => a - b);
    const v6aPacket = new Uint8Array(state.v6aLength);
    let offset = 0;
    for (const idx of sortedIndices) {
      const frag = state.fragments.get(idx)!;
      v6aPacket.set(frag, offset);
      offset += frag.length;
    }

    // Final invariant check.
    if (offset !== state.v6aLength) {
      this.groups.delete(key);
      return { status: 'error', reason: `Reconstruction offset mismatch: ${offset} !== ${state.v6aLength}` };
    }

    // Remove completed group.
    this.groups.delete(key);

    return { status: 'complete', v6aPacket };
  }

  /**
   * Remove expired incomplete groups.
   * Safe to call repeatedly.
   *
   * @returns Number of groups removed.
   */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, state] of this.groups) {
      if (now - state.createdAt > GROUP_EXPIRY_MS) {
        this.groups.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Remove all groups belonging to a source device.
   *
   * @param sourceId  Device to clear.
   */
  resetSource(sourceId: string): void {
    for (const [key, state] of this.groups) {
      if (state.sourceId === sourceId) {
        this.groups.delete(key);
      }
    }
  }

  /**
   * Abort and remove the oldest incomplete group.
   */
  private abortOldestGroup(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, state] of this.groups) {
      if (state.createdAt < oldestTime) {
        oldestTime = state.createdAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) {
      this.groups.delete(oldestKey);
    }
  }

  /**
   * Get the number of active reassembly groups (for testing/diagnostics).
   */
  get activeGroupCount(): number {
    return this.groups.size;
  }
}
