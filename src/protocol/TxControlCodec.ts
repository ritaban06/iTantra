/**
 * V6B TX Control — Half-Duplex Transmission Ownership Codec
 *
 * Implements the V6B_FRAME_TX_CONTROL (0x12) control-plane frame used to
 * arbitrate ONE transmitter at a time on a direct A↔B link.
 *
 * Payload layout (all multi-byte integers BIG_ENDIAN, total 9 bytes):
 *   Byte 0   : op        (UInt8)  — TX_OP_REQUEST / TX_OP_GRANT / TX_OP_RELEASE
 *   Bytes 1–4: txId      (UInt32) — owner's monotonic token for this turn
 *   Bytes 5–8: requestId (UInt32) — requester-provided correlation id
 *
 * Protocol flow (deterministic arbitration):
 *   REQUESTER                          OWNER/IDLE SIDE
 *   ────────                           ───────────────
 *   TX_OP_REQUEST(requestId)  ──────►  if idle: GRANT(txId, requestId); SELF is owner
 *                                      if busy: GRANT(txId=0, requestId) = implicit DENY
 *   ◄──────  TX_OP_GRANT(txId≠0)  or   TX_OP_GRANT(txId=0) (deny)
 *   [owns TX; sends voice DATA]        [WAITING — PTT gated locally]
 *   TX_OP_RELEASE(txId)       ──────►  ownership cleared → READY
 *
 * Denial is expressed as a GRANT with txId=0: a real grant always carries a
 * non-zero token, so "granted with txId=0" is unambiguous on both old and new
 * peers and needs no extra op value.
 *
 * Frames are plain V6B control traffic — exactly like ACK/NACK. They are
 * never relayed (direct-link concern), never meshed, and never reach TTS.
 */

import {
  V6B_FRAME_TX_CONTROL,
  TX_OP_REQUEST,
  TX_OP_GRANT,
  TX_OP_RELEASE,
  TX_CONTROL_PAYLOAD_SIZE,
} from './V6BFrameTypes';
import { encode as v6bEncode } from './V6BFrameCodec';

export {
  V6B_FRAME_TX_CONTROL,
  TX_OP_REQUEST,
  TX_OP_GRANT,
  TX_OP_RELEASE,
  TX_OWNER_NONE,
  TX_OWNER_SELF,
  TX_OWNER_REMOTE,
  TX_CONTROL_PAYLOAD_SIZE,
} from './V6BFrameTypes';

/** Decoded TX control payload. */
export interface TxControlPayload {
  op: number;
  txId: number;
  requestId: number;
}

// ── UInt32 big-endian helpers (same convention as V6BFrameCodec) ──

function writeUInt32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function readUInt32BE(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] << 24) |
      (data[offset + 1] << 16) |
      (data[offset + 2] << 8) |
      data[offset + 3]) >>>
    0
  );
}

/** Encode a TX control payload (9 bytes). Throws on out-of-range fields. */
export function encodeTxControlPayload(p: TxControlPayload): Uint8Array {
  if (!Number.isInteger(p.op) || p.op < 0 || p.op > 0xff) {
    throw new Error(`Invalid TX control op: ${p.op}`);
  }
  if (!Number.isInteger(p.txId) || p.txId < 0 || p.txId > 0xffffffff) {
    throw new Error(`Invalid TX control txId: ${p.txId}`);
  }
  if (!Number.isInteger(p.requestId) || p.requestId < 0 || p.requestId > 0xffffffff) {
    throw new Error(`Invalid TX control requestId: ${p.requestId}`);
  }
  const out = new Uint8Array(TX_CONTROL_PAYLOAD_SIZE);
  out[0] = p.op;
  writeUInt32BE(out, 1, p.txId);
  writeUInt32BE(out, 5, p.requestId);
  return out;
}

/**
 * Decode a TX control payload. Returns null for malformed input (wrong
 * length / unknown op) so callers can drop it safely without throwing.
 */
export function decodeTxControlPayload(data: Uint8Array): TxControlPayload | null {
  if (!(data instanceof Uint8Array) || data.length !== TX_CONTROL_PAYLOAD_SIZE) {
    return null;
  }
  const op = data[0];
  if (op !== TX_OP_REQUEST && op !== TX_OP_GRANT && op !== TX_OP_RELEASE) {
    return null;
  }
  return {
    op,
    txId: readUInt32BE(data, 1),
    requestId: readUInt32BE(data, 5),
  };
}

/** Build a complete V6B TX_CONTROL frame ready for NativeBLE.send. */
export function buildTxControlFrame(seq: number, p: TxControlPayload): Uint8Array {
  return v6bEncode(seq, V6B_FRAME_TX_CONTROL, encodeTxControlPayload(p));
}

/** True when a GRANT carries a real ownership token (not a deny). */
export function isGrantAccepted(p: TxControlPayload): boolean {
  return p.op === TX_OP_GRANT && p.txId !== 0;
}
