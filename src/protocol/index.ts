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
  decode,
  safeDecode,
  decodeWithFallback,
  validatePacket,
  getEncodedByteLength,
} from './BinaryMessageCodec';
