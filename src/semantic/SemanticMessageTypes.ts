/**
 * Semantic Message Types for iTantra BLE V4.
 *
 * These types define the structured message format that wraps STT transcripts
 * before sending over BLE. The JSON payload is encoded to UTF-8 → Base64
 * at the native bridge boundary.
 */

// ── Emotion ───────────────────────────────────────────────────────

/** Allowed emotion labels. V4 supports only neutral; others reserved for future ML integration. */
export type EmotionLabel = 'neutral' | 'happy' | 'sad' | 'angry';

export const VALID_EMOTIONS: EmotionLabel[] = ['neutral', 'happy', 'sad', 'angry'];

// ── Voice Profile ─────────────────────────────────────────────────

/** Voice profile identifier. V4 supports only 'default'. */
export type VoiceProfile = string;

// ── Semantic Message ──────────────────────────────────────────────

/**
 * The canonical semantic message exchanged over BLE.
 *
 * V4 schema:
 * - version: protocol version (must be 1)
 * - messageId: unique identifier, stable across the lifetime of the message
 * - text: the transcript or payload text (non-empty)
 * - language: ISO 639-1 language code (e.g., "en", "hi")
 * - emotion: detected emotion label
 * - emotionConfidence: confidence score in [0, 1]
 * - voiceProfile: voice profile identifier
 */
export interface SemanticMessage {
  version: number;
  messageId: string;
  text: string;
  language: string;
  emotion: EmotionLabel;
  emotionConfidence: number;
  voiceProfile: string;
}

// ── Supported Version ─────────────────────────────────────────────

export const SUPPORTED_VERSION = 1;

// ── Default Message Builder ───────────────────────────────────────

/**
 * Create a SemanticMessage with sensible defaults.
 * Only `text` is required; all other fields default to V4 placeholders.
 */
export function createSemanticMessage(
  text: string,
  overrides: Partial<Omit<SemanticMessage, 'text' | 'messageId'>> = {},
): SemanticMessage {
  return {
    version: SUPPORTED_VERSION,
    messageId: generateMessageId(),
    text,
    language: overrides.language ?? 'en',
    emotion: overrides.emotion ?? 'neutral',
    emotionConfidence: overrides.emotionConfidence ?? 0.0,
    voiceProfile: overrides.voiceProfile ?? 'default',
  };
}

// ── Message ID Generation ─────────────────────────────────────────

/**
 * Generate a unique message ID.
 *
 * Uses a combination of timestamp, random characters, and a counter
 * to ensure uniqueness and collision resistance for a mobile demo.
 *
 * Format: `msg_<timestamp-base36>_<random-hex>`
 */
let messageCounter = 0;

export function generateMessageId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(16).substring(2, 10);
  const counter = (messageCounter++).toString(36).padStart(2, '0');
  return `msg_${timestamp}_${random}_${counter}`;
}

// ── Language Display ──────────────────────────────────────────────

const LANGUAGE_DISPLAY_NAMES: Record<string, string> = {
  en: 'English',
  hi: 'Hindi',
  bn: 'Bengali',
  gu: 'Gujarati',
  mr: 'Marathi',
  kn: 'Kannada',
  ml: 'Malayalam',
  ta: 'Tamil',
  te: 'Telugu',
  or: 'Odia',
};

/** Get a human-readable language name from an ISO code. */
export function getLanguageDisplayName(code: string): string {
  return LANGUAGE_DISPLAY_NAMES[code] ?? code;
}

/** Capitalize the first letter of an emotion label for display. */
export function capitalizeEmotion(emotion: EmotionLabel): string {
  return emotion.charAt(0).toUpperCase() + emotion.slice(1);
}
