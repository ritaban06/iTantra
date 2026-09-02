/**
 * V9A BitChat TTL Manager
 *
 * Manages time-to-live values for mesh relay.
 * New packets start at DEFAULT_TTL. Each relay hop decrements by 1.
 * TTL 0 means the packet cannot be relayed further.
 */

import { DEFAULT_TTL, MAX_TTL } from '../core/BitChatConstants';

export class TTLManager {
  /** Default TTL for new packets. */
  static readonly DEFAULT = DEFAULT_TTL;

  /** Maximum allowed TTL. */
  static readonly MAX = MAX_TTL;

  /**
   * Create the initial TTL value for a new packet.
   *
   * @returns The default TTL (5).
   */
  static createInitialTTL(): number {
    return DEFAULT_TTL;
  }

  /**
   * Determine whether a packet with the given TTL can be relayed.
   *
   * @param ttl  Current TTL value.
   * @returns true if the packet can be relayed (ttl > 0).
   */
  static canRelay(ttl: number): boolean {
    if (!Number.isInteger(ttl) || ttl < 0 || ttl > 255) {
      return false;
    }
    return ttl > 0;
  }

  /**
   * Decrement the TTL by exactly 1 for a relay hop.
   *
   * @param ttl  Current TTL value.
   * @returns The decremented TTL (minimum 0).
   * @throws If the TTL is invalid (not an integer, negative, or > 255).
   */
  static decrement(ttl: number): number {
    if (!Number.isInteger(ttl) || ttl < 0 || ttl > 255) {
      throw new Error(`Invalid TTL: ${ttl}`);
    }
    return Math.max(0, ttl - 1);
  }
}
