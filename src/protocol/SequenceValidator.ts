/**
 * V6B Inbound Sequence Validator
 *
 * Tracks the last received sequence number per source device.
 * Detects expected sequences, gaps, and duplicates.
 *
 * Responsibilities:
 *   - validate(sourceId, sequence) → structured result
 *   - reset(sourceId) → clear state for a device
 *
 * Does NOT:
 *   - generate outbound sequence numbers
 *   - encode/decode frames
 *   - perform retransmission or ACK
 */

const UINT32_MAX = 0xffffffff;

/**
 * Result of sequence validation.
 */
export interface SequenceValidationResult {
  /** Whether the sequence is accepted (not a duplicate). */
  valid: boolean;
  /** True if the sequence is ahead of expected (gap detected). */
  gap?: boolean;
  /** True if the sequence is at or behind the last received (duplicate detected). */
  duplicate?: boolean;
}

interface SourceState {
  /** Whether we have received any sequence from this source. */
  initialized: boolean;
  /** Last received sequence number. */
  lastReceived: number;
}

export class SequenceValidator {
  private sources = new Map<string, SourceState>();

  /**
   * Validate an incoming sequence number from a source device.
   *
   * Rules:
   *   - First sequence from a source → valid
   *   - Expected next sequence → valid
   *   - Sequence ahead of expected → valid + gap=true
   *   - Sequence equal to or behind last received → valid=false + duplicate=true
   *
   * UInt32 wraparound is handled correctly.
   *
   * @param sourceId  Identifier of the sending device.
   * @param sequence  The UInt32 sequence number from the frame.
   * @returns Validation result.
   */
  validate(sourceId: string, sequence: number): SequenceValidationResult {
    const state = this.sources.get(sourceId);

    if (!state || !state.initialized) {
      // First sequence from this source.
      this.sources.set(sourceId, { initialized: true, lastReceived: sequence });
      return { valid: true };
    }

    const last = state.lastReceived;

    if (sequence === last) {
      // Exact duplicate.
      return { valid: false, duplicate: true };
    }

    // Compute expected next sequence (with UInt32 wraparound).
    const expected = (last + 1) & UINT32_MAX;

    if (sequence === expected) {
      // Expected next sequence.
      state.lastReceived = sequence;
      return { valid: true };
    }

    // Determine if ahead (gap) or behind (older duplicate).
    // For UInt32, we check if sequence is "ahead" of lastReceived
    // by computing the forward distance.
    const forwardDistance = (sequence - last - 1 + (UINT32_MAX + 1)) % (UINT32_MAX + 1);

    if (forwardDistance < (UINT32_MAX / 2)) {
      // sequence is ahead of lastReceived → gap
      state.lastReceived = sequence;
      return { valid: true, gap: true };
    } else {
      // sequence is behind lastReceived → older duplicate
      return { valid: false, duplicate: true };
    }
  }

  /**
   * Reset sequence state for a source device.
   * Call on reconnect or when starting a new session.
   *
   * @param sourceId  Identifier of the sending device.
   */
  reset(sourceId: string): void {
    this.sources.delete(sourceId);
  }
}
