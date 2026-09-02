/**
 * V8 Reliability Manager — Per-Peer
 *
 * Manages reliable delivery for one BLE peer connection.
 *
 * Sender responsibilities:
 *   - Track pending reliable message
 *   - Start ACK timeout timer
 *   - Retransmit on timeout or NACK (directly via sendFn + seqManager)
 *   - Handle ACK → clear pending state
 *   - Handle NACK → full group retransmission
 *   - Enforce max retries
 *   - Queue one additional message
 *
 * Concurrency invariant:
 *   At any moment, only one logical message's DATA frames may be in flight.
 *   ACK arriving during retransmission defers queue promotion until the
 *   retransmission loop exits. A generation counter invalidates stale loops.
 *
 * Receiver responsibilities:
 *   - Generate ACK frames
 *   - Generate NACK frames
 */

import {
  ACK_TIMEOUT_MS,
  MAX_RETRIES,
  PENDING_EXPIRY_MS,
  MAX_NACKS_PER_SECOND,
  NACK_PAYLOAD_SIZE,
  ACK_PAYLOAD_SIZE,
  PendingMessage,
  ReliabilityEvent,
} from './ReliabilityTypes';
import { SequenceManager } from './SequenceManager';
import { encode as v6bEncode } from './V6BFrameCodec';
import { V6B_FRAME_V6A_MESSAGE } from './V6BFrameTypes';

// ── BIG_ENDIAN Helpers ────────────────────────────────────────────

function writeUInt64BE(buf: Uint8Array, offset: number, value: bigint): void {
  for (let i = 0; i < 8; i++) {
    buf[offset + i] = Number((value >> BigInt(56 - i * 8)) & BigInt(0xff));
  }
}

function readUInt64BE(buf: Uint8Array, offset: number): bigint {
  let value = BigInt(0);
  for (let i = 0; i < 8; i++) {
    value = (value << BigInt(8)) | BigInt(buf[offset + i] & 0xff);
  }
  return value;
}

function writeUInt32BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

// ── Send Result ───────────────────────────────────────────────────

/**
 * Result of calling send(). Tells the integration layer whether
 * the message became active (should send DATA frames now) or was queued.
 */
export interface SendResult {
  /** Whether the message became the active message (needs immediate DATA send). */
  active: boolean;
  /** The PendingMessage that was created. */
  message: PendingMessage;
}

// ── ReliabilityManager ────────────────────────────────────────────

export class ReliabilityManager {
  /** The peer this manager serves. */
  private readonly peerId: string;

  /** Sequence manager for outbound frames (ACK, NACK, retransmissions). */
  private seqManager: SequenceManager;

  /** Active reliable message (at most one). */
  private active: PendingMessage | null = null;

  /** Queued message waiting for active to complete (at most one). */
  private queued: PendingMessage | null = null;

  /** Retransmission timer. */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  /** Callback to send a V6B frame over BLE. */
  private sendFn: ((frame: Uint8Array) => Promise<void>) | null = null;

  /** Callback for reliability events (for UI status / logging). */
  private onEvent: ((event: ReliabilityEvent) => void) | null = null;

  /**
   * Callback invoked when a queued message is promoted to active.
   * The integration must send the promoted message's DATA frames and
   * then call onFrameSent() to start its retry timer.
   */
  private onPromote: ((message: PendingMessage) => void) | null = null;

  /** Reverse lookup: groupId → messageId for fragmented messages. */
  private groupIdToMessageId = new Map<number, string>();

  /** NACK rate limiting: timestamps of recent NACKs per source. */
  private nackTimestamps: number[] = [];

  /** Whether a retransmission is currently in progress. */
  private retransmitting = false;

  /**
   * Generation counter. Incremented on cancel, MAX_RETRIES, or any event
   * that should invalidate an in-flight retransmission loop.
   */
  private retransmitGeneration = 0;

  /** Promise for the in-flight retransmission (for testing). */
  private retransmitPromise: Promise<void> | null = null;

  constructor(peerId: string, seqManager: SequenceManager) {
    this.peerId = peerId;
    this.seqManager = seqManager;
  }

  setSendFn(fn: (frame: Uint8Array) => Promise<void>): void {
    this.sendFn = fn;
  }

  setOnEvent(fn: (event: ReliabilityEvent) => void): void {
    this.onEvent = fn;
  }

  /**
   * Set callback for when a queued message is promoted to active.
   * The integration must send the promoted message's DATA frames and
   * call onFrameSent() after completion.
   */
  setOnPromote(fn: (message: PendingMessage) => void): void {
    this.onPromote = fn;
  }

  // ── Sender: Send ──────────────────────────────────────────────

  /**
   * Register a reliable message.
   *
   * Returns a SendResult indicating whether the message became active
   * (integration should send DATA frames) or was queued (integration
   * should NOT send anything — the onPromote callback will fire when
   * it's time).
   */
  send(params: {
    messageId: string;
    v6aPacket: Uint8Array;
    groupId?: number;
    fragments?: Uint8Array[];
    payloads?: Uint8Array[];
  }): SendResult {
    const { messageId, v6aPacket, groupId = 0, fragments = [], payloads = [] } = params;

    const now = Date.now();
    const msg: PendingMessage = {
      messageId,
      groupId,
      v6aPacket,
      fragments,
      payloads,
      acked: false,
      retryCount: 0,
      lastSendAt: now,
      createdAt: now,
    };

    if (!this.active) {
      this.active = msg;
      return { active: true, message: msg };
    }

    if (!this.queued) {
      this.queued = msg;
      return { active: false, message: msg };
    }

    // Both occupied — drop the queued, keep active.
    this.queued = msg;
    return { active: false, message: msg };
  }

  /**
   * Called by the integration hook after sending the initial DATA frame(s).
   * Starts the retry timer for ACK timeout.
   */
  onFrameSent(): void {
    if (this.active) {
      this.active.lastSendAt = Date.now();
      this.startRetryTimer();
    }
  }

  // ── Sender: Handle ACK ────────────────────────────────────────

  handleAck(messageId: string): void {
    if (this.active && this.active.messageId === messageId) {
      this.clearRetryTimer();
      this.active.acked = true;

      if (this.active.groupId !== 0) {
        this.groupIdToMessageId.delete(this.active.groupId);
      }

      const event: ReliabilityEvent = {
        type: 'ACK_RECEIVED',
        messageId,
        groupId: this.active.groupId || undefined,
      };

      if (this.retransmitting) {
        // ACK during retransmission — defer promotion.
        this.onEvent?.(event);
        return;
      }

      // No retransmission in progress — promote immediately.
      this.active = null;
      this.onEvent?.(event);
      this.promoteQueued();
      return;
    }

    if (this.queued && this.queued.messageId === messageId) {
      this.queued.acked = true;
      if (this.queued.groupId !== 0) {
        this.groupIdToMessageId.delete(this.queued.groupId);
      }
      this.queued = null;
      return;
    }
  }

  // ── Sender: Handle NACK ───────────────────────────────────────

  handleNack(groupId: number, reason: number): void {
    const messageId = this.groupIdToMessageId.get(groupId);
    if (!messageId) return;

    if (!this.active || this.active.messageId !== messageId) return;

    this.active.retryCount++;
    this.active.lastSendAt = Date.now();

    if (this.active.retryCount > MAX_RETRIES) {
      const msg = this.active;
      this.clearRetryTimer();
      this.retransmitGeneration++;
      this.retransmitting = false;

      if (msg.groupId !== 0) {
        this.groupIdToMessageId.delete(msg.groupId);
      }

      this.active = null;
      this.onEvent?.({
        type: 'MAX_RETRIES',
        messageId: msg.messageId,
        groupId: msg.groupId || undefined,
      });

      this.promoteQueued();
      return;
    }

    this.clearRetryTimer();

    this.onEvent?.({
      type: 'NACK_RECEIVED',
      messageId,
      groupId,
      reason,
    });

    this.retransmit();
  }

  // ── Sender: Timeout ───────────────────────────────────────────

  handleTimeout(): void {
    if (!this.active) return;

    this.active.retryCount++;
    this.active.lastSendAt = Date.now();

    if (this.active.retryCount > MAX_RETRIES) {
      const msg = this.active;
      this.retransmitGeneration++;
      this.retransmitting = false;

      if (msg.groupId !== 0) {
        this.groupIdToMessageId.delete(msg.groupId);
      }

      this.active = null;
      this.onEvent?.({
        type: 'MAX_RETRIES',
        messageId: msg.messageId,
        groupId: msg.groupId || undefined,
      });

      this.promoteQueued();
      return;
    }

    this.onEvent?.({
      type: 'TIMEOUT_RETRY',
      messageId: this.active.messageId,
      groupId: this.active.groupId || undefined,
    });

    this.retransmit();
  }

  // ── Sender: Retransmit ───────────────────────────────────────

  private retransmit(): void {
    if (!this.active || !this.sendFn) return;
    if (this.retransmitting) return;

    this.retransmitting = true;

    const msg = this.active;
    const generation = ++this.retransmitGeneration;

    const doRetransmit = async (): Promise<void> => {
      try {
        if (msg.fragments.length === 0) {
          // Single-frame
          if (this.retransmitGeneration === generation && !msg.acked) {
            const seq = this.seqManager.nextSequence();
            const frame = v6bEncode(seq, V6B_FRAME_V6A_MESSAGE, msg.v6aPacket);
            await this.sendFn!(frame);
          }
        } else {
          // Fragmented
          for (let i = 0; i < msg.payloads.length; i++) {
            if (this.retransmitGeneration !== generation || msg.acked) break;
            const seq = this.seqManager.nextSequence();
            const frame = v6bEncode(seq, V6B_FRAME_V6A_MESSAGE, msg.payloads[i]);
            await this.sendFn!(frame);
          }
        }
      } catch (err) {
        console.warn(`[ReliabilityManager] Retransmission send failed: ${err}`);
      }

      if (this.retransmitGeneration === generation) {
        this.retransmitting = false;

        if (msg.acked) {
          // ACK arrived during retransmission — now safe to promote.
          this.active = null;
          this.promoteQueued();
        } else if (this.active && this.active.messageId === msg.messageId) {
          // Same message still active — restart timer.
          this.startRetryTimer();
        }
      }
    };

    this.retransmitPromise = doRetransmit();
  }

  // ── Sender: Cancel ────────────────────────────────────────────

  cancel(): void {
    this.clearRetryTimer();
    this.retransmitGeneration++;
    this.retransmitting = false;
    this.retransmitPromise = null;

    if (this.active?.groupId) {
      this.groupIdToMessageId.delete(this.active.groupId);
    }
    if (this.queued?.groupId) {
      this.groupIdToMessageId.delete(this.queued.groupId);
    }

    const activeMsg = this.active;
    this.active = null;
    this.queued = null;

    if (activeMsg) {
      this.onEvent?.({
        type: 'CANCELLED',
        messageId: activeMsg.messageId,
      });
    }
  }

  // ── Receiver: Generate ACK ────────────────────────────────────

  static buildAckPayload(messageId: string): Uint8Array {
    const payload = new Uint8Array(ACK_PAYLOAD_SIZE);
    const hash = BigInt(messageId);
    writeUInt64BE(payload, 0, hash);
    return payload;
  }

  static parseAckPayload(payload: Uint8Array): string | null {
    if (payload.length < ACK_PAYLOAD_SIZE) return null;
    const hash = readUInt64BE(payload, 0);
    return `0x${hash.toString(16).padStart(16, '0')}`;
  }

  // ── Receiver: Generate NACK ───────────────────────────────────

  static buildNackPayload(groupId: number, reason: number): Uint8Array {
    const payload = new Uint8Array(NACK_PAYLOAD_SIZE);
    writeUInt32BE(payload, 0, groupId);
    payload[4] = reason;
    return payload;
  }

  static parseNackPayload(payload: Uint8Array): { groupId: number; reason: number } | null {
    if (payload.length < NACK_PAYLOAD_SIZE) return null;
    const groupId = ((payload[0] & 0xff) << 24) |
                    ((payload[1] & 0xff) << 16) |
                    ((payload[2] & 0xff) << 8) |
                    (payload[3] & 0xff);
    const reason = payload[4];
    return { groupId, reason };
  }

  canNack(): boolean {
    const now = Date.now();
    this.nackTimestamps = this.nackTimestamps.filter(t => now - t < 1000);
    if (this.nackTimestamps.length >= MAX_NACKS_PER_SECOND) {
      return false;
    }
    this.nackTimestamps.push(now);
    return true;
  }

  // ── Internal Helpers ──────────────────────────────────────────

  private startRetryTimer(): void {
    this.clearRetryTimer();
    this.retryTimer = setTimeout(() => {
      this.handleTimeout();
    }, ACK_TIMEOUT_MS);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /**
   * Promote the queued message to active.
   * Invokes onPromote callback so the integration can send DATA frames.
   */
  private promoteQueued(): void {
    if (this.queued) {
      this.active = this.queued;
      this.queued = null;
      this.active.retryCount = 0;
      this.active.lastSendAt = Date.now();
      // Timer will be started by integration after sending (via onFrameSent).
      // Invoke callback so integration knows to send this message's DATA frames.
      this.onPromote?.(this.active);
    }
  }

  // ── Accessors (for testing and integration) ───────────────────

  getActiveMessage(): PendingMessage | null {
    return this.active;
  }

  getQueuedMessage(): PendingMessage | null {
    return this.queued;
  }

  hasActiveMessage(): boolean {
    return this.active !== null;
  }

  hasQueuedMessage(): boolean {
    return this.queued !== null;
  }

  isRetransmitting(): boolean {
    return this.retransmitting;
  }

  async waitForRetransmission(): Promise<void> {
    if (this.retransmitPromise) {
      await this.retransmitPromise;
    }
  }

  registerGroupId(groupId: number, messageId: string): void {
    this.groupIdToMessageId.set(groupId, messageId);
  }

  cleanup(): void {
    const now = Date.now();
    if (this.active && now - this.active.createdAt > PENDING_EXPIRY_MS) {
      this.cancel();
    }
  }
}
