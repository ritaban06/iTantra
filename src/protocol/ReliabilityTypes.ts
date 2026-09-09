/**
 * V8 Reliable BLE Delivery — Type Constants
 *
 * Defines the constants, interfaces, and error types for the
 * point-to-point reliability layer.
 */

// ── Timing ────────────────────────────────────────────────────────

/** ACK timeout in milliseconds. */
export const ACK_TIMEOUT_MS = 2_000;

/** Maximum retransmission attempts before failure. */
export const MAX_RETRIES = 3;

/** Pending message expiry in milliseconds. Must exceed GROUP_EXPIRY_MS (30s) + margin. */
export const PENDING_EXPIRY_MS = 40_000;

// ── Cache Limits ──────────────────────────────────────────────────

/** Maximum entries in DeliveredMessageCache per peer. */
export const DELIVERED_CACHE_MAX = 64;

/** Retention time for delivered cache entries in milliseconds. */
export const DELIVERED_CACHE_RETENTION_MS = 60_000;

/** Maximum entries in CompletedGroupCache per peer. */
export const COMPLETED_CACHE_MAX = 64;

/** Retention time for completed group cache entries in milliseconds. */
export const COMPLETED_CACHE_RETENTION_MS = 60_000;

// ── Queue Limits ──────────────────────────────────────────────────

/** Maximum queued messages per peer (beyond the active one). */
export const MAX_QUEUED_MESSAGES = 1;

// ── NACK Rate Limiting ────────────────────────────────────────────

/** Maximum NACKs generated per second per source. */
export const MAX_NACKS_PER_SECOND = 4;

/** NACK payload size in bytes. */
export const NACK_PAYLOAD_SIZE = 10;

/** ACK payload size in bytes. */
export const ACK_PAYLOAD_SIZE = 8;

// ── NACK Reason Codes ────────────────────────────────────────────

/** Malformed frame — no NACK generated (silent drop). */
export const NACK_REASON_MALFORMED_FRAME = 0x01;

/** Invalid V7 fragment. */
export const NACK_REASON_INVALID_FRAGMENT = 0x02;

/** Fragment metadata conflict. */
export const NACK_REASON_METADATA_CONFLICT = 0x03;

/** Reassembly group expired. */
export const NACK_REASON_REASSEMBLY_EXPIRED = 0x04;

/** Unsupported protocol — no NACK generated (silent drop). */
export const NACK_REASON_UNSUPPORTED_PROTOCOL = 0x05;

// ── Sender States ─────────────────────────────────────────────────

export type SenderState =
  | 'PENDING'
  | 'SUCCESS'
  | 'RETRYING'
  | 'FAILED_MAX_RETRIES'
  | 'CANCELLED';

// ── Receiver States ───────────────────────────────────────────────

export type ReceiverState =
  | 'RECEIVED'
  | 'DELIVERED'
  | 'DUPLICATE'
  | 'INCOMPLETE'
  | 'REJECTED'
  | 'EXPIRED';

// ── Pending Message ───────────────────────────────────────────────

/**
 * Sender-side state for a reliable message awaiting ACK.
 */
export interface PendingMessage {
  /** V6A messageId (FNV-1a hash as hex string). */
  messageId: string;

  /** V7 groupId (0 for single-frame messages). */
  groupId: number;

  /** Complete V6A packet bytes (for retransmission). */
  v6aPacket: Uint8Array;

  /** V7 fragment payloads (empty array for single-frame). */
  fragments: Uint8Array[];

  /** V6B payload data for each fragment/frame (for rebuilding V6B frames). */
  payloads: Uint8Array[];

  /** Whether ACK has been received. */
  acked: boolean;

  /** Current retry count. */
  retryCount: number;

  /** Timestamp of last send attempt (ms). */
  lastSendAt: number;

  /** Timestamp when message was first sent (ms). */
  createdAt: number;
}

// ── Reliability Event ─────────────────────────────────────────────

/**
 * Event emitted by ReliabilityManager for integration with the UI hook.
 */
export interface ReliabilityEvent {
  type: 'ACK_RECEIVED' | 'NACK_RECEIVED' | 'MAX_RETRIES' | 'TIMEOUT_RETRY' | 'CANCELLED';
  messageId: string;
  groupId?: number;
  reason?: number;
}

// ── Delivered Cache Entry ─────────────────────────────────────────

export interface DeliveredEntry {
  messageId: string;
  deliveredAt: number;
}

// ── Completed Group Cache Entry ───────────────────────────────────

export interface CompletedGroupEntry {
  groupId: number;
  messageId: string;
  completedAt: number;
}
