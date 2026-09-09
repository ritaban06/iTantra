/**
 * V6B Outbound Sequence Manager
 *
 * Generates monotonically increasing UInt32 sequence numbers for V6B frames.
 * One instance per outbound link (per BLE connection).
 *
 * Behavior:
 *   - Counter starts at 0
 *   - nextSequence() returns current value, then increments
 *   - Wraps from 0xFFFFFFFF to 0x00000000
 */

const UINT32_MAX = 0xffffffff;

export class SequenceManager {
  private counter: number;

  constructor(initialSequence: number = 0) {
    this.counter = (initialSequence & UINT32_MAX) >>> 0;
  }

  /**
   * Return the next sequence number and increment the counter.
   *
   * Uses >>> 0 to convert from signed 32-bit to unsigned, ensuring
   * values like 0xFFFFFFFF return as 4294967295 (not -1).
   *
   * @returns The current UInt32 sequence number (unsigned).
   */
  nextSequence(): number {
    const seq = this.counter >>> 0;
    this.counter = ((this.counter + 1) & UINT32_MAX) >>> 0;
    return seq;
  }

  /**
   * Peek at the next sequence number without incrementing.
   *
   * @returns The next UInt32 sequence number that will be returned.
   */
  peek(): number {
    return this.counter >>> 0;
  }
}
