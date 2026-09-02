/**
 * V6A Binary Semantic Protocol — Public API
 *
 * Re-exports constants and codec functions for the binary message format.
 */

export {
  PROTOCOL_VERSION,
  MSG_TYPE_TEXT,
  VALID_MESSAGE_TYPES,
  LANGUAGE_REGISTRY,
  LANGUAGE_CODE_TO_ISO,
  VALID_LANGUAGE_CODES,
  EMOTION_REGISTRY,
  EMOTION_CODE_TO_LABEL,
  VALID_EMOTION_CODES,
  VOICE_PROFILE_REGISTRY,
  VOICE_PROFILE_CODE_TO_LABEL,
  VALID_VOICE_PROFILE_CODES,
  HEADER_SIZE,
  MAX_BLE_PAYLOAD,
  MAX_TEXT_LENGTH,
} from './BinaryMessageTypes';

export {
  BinaryCodecError,
  fnv1a64,
  hashMessageId,
  encode,
  encodeUnrestricted,
  decode,
  safeDecode,
  decodeWithFallback,
  validatePacket,
  getEncodedByteLength,
} from './BinaryMessageCodec';

// ── V6B Transport Envelope ───────────────────────────────────────

export {
  V6B_VERSION,
  V6B_FRAME_V6A_MESSAGE,
  V6B_FRAME_ACK,
  V6B_FRAME_NACK,
  V6B_FRAME_PING,
  V6B_FRAME_PONG,
  V6B_VALID_FRAME_TYPES,
  V6B_HEADER_SIZE,
  V6B_MAX_FRAME_SIZE,
  V6B_MAX_PAYLOAD_SIZE,
  V6BFrameError,
} from './V6BFrameTypes';

export type { V6BDecodedFrame } from './V6BFrameTypes';

export {
  encode as v6bEncode,
  decode as v6bDecode,
  safeDecode as v6bSafeDecode,
  validateFrame as v6bValidateFrame,
} from './V6BFrameCodec';

export { SequenceManager } from './SequenceManager';

export {
  SequenceValidator,
} from './SequenceValidator';

export type { SequenceValidationResult } from './SequenceValidator';

// ── V7 BLE Fragmentation ────────────────────────────────────────

export {
  V7_MARKER,
  V7_HEADER_SIZE,
  MAX_FRAGMENTS,
  MAX_CHUNK_SIZE,
  MAX_V6A_LENGTH,
  MAX_CONCURRENT_GROUPS,
  GROUP_EXPIRY_MS,
  MAX_GROUP_KEY_LENGTH,
  V7_MAX_V6B_PAYLOAD,
  V7_MAX_V6B_FRAME,
  V7FragmentError,
} from './V7FragmentTypes';

export type {
  FragmentHeader,
  FragmentChunk,
  FragmentState,
  ReassemblyResult,
} from './V7FragmentTypes';

export {
  splitV6A,
  parseHeader,
} from './FragmentCodec';

export { Reassembler } from './Reassembler';
