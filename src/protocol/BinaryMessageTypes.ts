/**
 * V6A Binary Semantic Protocol — Type Constants
 *
 * Wire format (all multi-byte integers BIG_ENDIAN):
 *
 *   Byte  0      : version      (UInt8)   — 0x02
 *   Byte  1      : messageType  (UInt8)   — 0x01 = TEXT
 *   Byte  2      : language     (UInt8)   — numeric language code
 *   Byte  3      : emotion      (UInt8)   — 0x00=neutral, 0x01=happy, 0x02=sad, 0x03=angry
 *   Byte  4      : confidence   (UInt8)   — round(emotionConfidence × 255), clamped 0..255
 *   Byte  5      : voiceProfile (UInt8)   — 0x00=default
 *   Bytes 6–13   : messageId    (UInt64)  — FNV-1a 64-bit hash of the string messageId
 *   Bytes 14–17  : textLength   (UInt32)  — byte length of UTF-8 text payload
 *   Bytes 18…    : text         (N bytes) — UTF-8 transcript text
 *
 * Total packet size: 18 + textLength
 */

// ── Protocol Version ──────────────────────────────────────────────

/** V6A binary protocol version byte. */
export const PROTOCOL_VERSION = 0x02;

// ── Message Type ──────────────────────────────────────────────────

/** Message type: TEXT (speech transcript). */
export const MSG_TYPE_TEXT = 0x01;

/** Set of all recognized message types for validation. */
export const VALID_MESSAGE_TYPES = new Set([MSG_TYPE_TEXT]);

// ── Language Registry ─────────────────────────────────────────────

/**
 * Numeric language codes for the V6A binary wire format.
 *
 * 0x00 = unknown/default
 * 0x01–0x0A = supported Indian languages + English
 */
export const LANGUAGE_REGISTRY: Record<string, number> = {
  unknown: 0x00,
  en: 0x01,
  hi: 0x02,
  bn: 0x03,
  gu: 0x04,
  mr: 0x05,
  kn: 0x06,
  ml: 0x07,
  ta: 0x08,
  te: 0x09,
  or: 0x0a,
};

/** Reverse lookup: numeric code → ISO 639-1 string. */
export const LANGUAGE_CODE_TO_ISO: Record<number, string> = {};
for (const [iso, code] of Object.entries(LANGUAGE_REGISTRY)) {
  LANGUAGE_CODE_TO_ISO[code] = iso;
}

/** Set of valid numeric language codes. */
export const VALID_LANGUAGE_CODES = new Set(
  Object.values(LANGUAGE_REGISTRY),
);

// ── Emotion Registry ──────────────────────────────────────────────

/** Emotion label → wire byte. */
export const EMOTION_REGISTRY: Record<string, number> = {
  neutral: 0x00,
  happy: 0x01,
  sad: 0x02,
  angry: 0x03,
};

/** Reverse lookup: wire byte → emotion label. */
export const EMOTION_CODE_TO_LABEL: Record<number, string> = {};
for (const [label, code] of Object.entries(EMOTION_REGISTRY)) {
  EMOTION_CODE_TO_LABEL[code] = label;
}

/** Set of valid emotion wire codes. */
export const VALID_EMOTION_CODES = new Set(
  Object.values(EMOTION_REGISTRY),
);

// ── Voice Profile Registry ────────────────────────────────────────

/** Voice profile → wire byte. V6A: only "default" (0x00). */
export const VOICE_PROFILE_REGISTRY: Record<string, number> = {
  default: 0x00,
};

/** Reverse lookup: wire byte → voice profile string. */
export const VOICE_PROFILE_CODE_TO_LABEL: Record<number, string> = {};
for (const [label, code] of Object.entries(VOICE_PROFILE_REGISTRY)) {
  VOICE_PROFILE_CODE_TO_LABEL[code] = label;
}

/** Set of valid voice profile wire codes. */
export const VALID_VOICE_PROFILE_CODES = new Set(
  Object.values(VOICE_PROFILE_REGISTRY),
);

// ── Fixed Header Size ─────────────────────────────────────────────

/**
 * Fixed header size in bytes (everything before the variable-length text).
 * version(1) + messageType(1) + language(1) + emotion(1) + confidence(1) +
 * voiceProfile(1) + messageId(8) + textLength(4) = 18
 */
export const HEADER_SIZE = 18;

// ── Maximum Packet Size ───────────────────────────────────────────

/**
 * Maximum usable BLE payload after GATT overhead.
 * Negotiated MTU = 512, ATT overhead = 3, so usable = 509.
 */
export const MAX_BLE_PAYLOAD = 509;

/** Maximum text length allowed by the protocol (UInt32 max, but practically bounded by BLE). */
export const MAX_TEXT_LENGTH = MAX_BLE_PAYLOAD - HEADER_SIZE; // 491 bytes
