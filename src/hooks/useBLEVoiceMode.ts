import { useState, useEffect, useCallback, useRef } from 'react';
import { NativeEventEmitter, NativeModules } from 'react-native';
import NativeBLE from '../native/NativeBLE';
import NativeSTT from '../native/NativeSTT';
import {
  SemanticMessage,
  createSemanticMessage,
  encode,
  safeDecode,
  getEncodedByteLength,
  getLanguageDisplayName,
  capitalizeEmotion,
} from '../semantic';

const { NativeSTT: NativeSTTModule } = NativeModules;
const { NativeTTS } = NativeModules;

export type BLEVoiceModeStatus =
  | 'OFF'
  | 'WAITING_FOR_SPEECH'
  | 'SENDING'
  | 'SENT'
  | 'RECEIVING'
  | 'SPEAKING'
  | 'ERROR';

/**
 * A received BLE message with semantic metadata.
 */
export interface BLEVoiceMessage {
  /** Decoded semantic message, or null if raw text (legacy V3). */
  semanticMessage: SemanticMessage | null;
  /** Human-readable text extracted from the message. */
  text: string;
  /** Device that sent this message. */
  fromDevice: string;
  /** Timestamp of reception. */
  time: number;
  /** Display status. */
  status: 'received' | 'speaking' | 'spoken';
  /** Language display name. */
  languageDisplay: string;
  /** Emotion display name. */
  emotionDisplay: string;
  /** Emotion confidence percentage. */
  emotionConfidencePct: number;
  /** Voice profile display. */
  voiceProfileDisplay: string;
}

/**
 * Integration hook: STT → SemanticMessage → BLE → SemanticMessage → TTS.
 *
 * When BLE Voice Mode is enabled:
 * - Final STT transcripts are wrapped in a SemanticMessage and sent over BLE.
 * - Received BLE data is decoded as SemanticMessage, then spoken via TTS.
 * - Mic is muted during TTS playback to prevent feedback loops.
 */
export function useBLEVoiceMode(languageCode: string = 'en') {
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<BLEVoiceModeStatus>('OFF');
  const [lastSentMessage, setLastSentMessage] = useState<SemanticMessage | null>(null);
  const [sendStatus, setSendStatus] = useState<'idle' | 'sent' | 'failed'>('idle');
  const [lastReceivedMessage, setLastReceivedMessage] = useState<BLEVoiceMessage | null>(null);
  const [receivedMessages, setReceivedMessages] = useState<BLEVoiceMessage[]>([]);
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const subsRef = useRef<Array<{ remove: () => void }>>([]);
  const isMutedRef = useRef(false);
  const languageCodeRef = useRef(languageCode);

  // Keep languageCode ref current for event handlers.
  languageCodeRef.current = languageCode;

  // ── Subscribe to STT and BLE events ────────────────────────────────

  useEffect(() => {
    const sttEmitter = new NativeEventEmitter(NativeSTTModule);

    // When a final STT result arrives and voice mode is on + connected, send via BLE.
    const sttResultSub = sttEmitter.addListener('STT_RESULT', (event: any) => {
      if (!enabled) return;

      const transcript = event.transcript?.trim();
      if (!transcript) return;

      // Check BLE connection state.
      if (NativeBLE.getConnectionState) {
        NativeBLE.getConnectionState().then((info: any) => {
          if (info.state !== 'CONNECTED') {
            setVoiceError('Not connected to a device');
            return;
          }

          // Create a SemanticMessage from the STT transcript.
          const semanticMsg = createSemanticMessage(transcript, {
            language: languageCodeRef.current,
          });

          const encoded = encode(semanticMsg);
          const byteLen = getEncodedByteLength(semanticMsg);

          console.log(
            `[BLE Voice] Sending message ${semanticMsg.messageId} (${byteLen} bytes): "${transcript}"`,
          );

          setLastSentMessage(semanticMsg);
          setStatus('SENDING');
          setSendStatus('idle');

          // Base64-encode for the native bridge.
          let base64: string;
          try {
            base64 = (globalThis as any).btoa(encoded);
          } catch {
            const bytes: number[] = [];
            for (let i = 0; i < encoded.length; i++) {
              const code = encoded.charCodeAt(i);
              if (code < 0x80) bytes.push(code);
              else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
              else bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
            }
            base64 = (globalThis as any).btoa(String.fromCharCode(...bytes));
          }

          NativeBLE.send(base64)
            .then(() => {
              setSendStatus('sent');
              setStatus('SENT');
              setTimeout(() => {
                if (enabled) setStatus('WAITING_FOR_SPEECH');
              }, 1500);
            })
            .catch((err: any) => {
              setSendStatus('failed');
              setVoiceError(`Send failed: ${err.message || err}`);
              setStatus('ERROR');
            });
        });
      }
    });

    // When BLE data is received, decode as SemanticMessage and speak via TTS.
    const bleDataSub = NativeBLE.onDataReceived((event: { data: string; fromDevice: string }) => {
      let decoded: string;
      try {
        decoded = (globalThis as any).atob(event.data);
      } catch {
        decoded = event.data;
      }

      if (!decoded.trim()) return;

      // Try to decode as a SemanticMessage (V4 path).
      const semanticMsg = safeDecode(decoded);

      let text: string;
      let languageDisplay: string;
      let emotionDisplay: string;
      let emotionConfidencePct: number;
      let voiceProfileDisplay: string;

      if (semanticMsg) {
        // Successfully decoded as semantic message.
        text = semanticMsg.text;
        languageDisplay = getLanguageDisplayName(semanticMsg.language);
        emotionDisplay = capitalizeEmotion(semanticMsg.emotion);
        emotionConfidencePct = Math.round(semanticMsg.emotionConfidence * 100);
        voiceProfileDisplay = semanticMsg.voiceProfile;
        console.log(
          `[BLE Voice] Received message ${semanticMsg.messageId} from ${event.fromDevice}: "${text}"`,
        );
      } else {
        // Fallback: treat as plain text (V3 legacy or malformed).
        text = decoded;
        languageDisplay = 'Unknown';
        emotionDisplay = 'Unknown';
        emotionConfidencePct = 0;
        voiceProfileDisplay = 'Unknown';
        console.warn(`[BLE Voice] Received unparseable data from ${event.fromDevice}, treating as plain text`);
      }

      const message: BLEVoiceMessage = {
        semanticMessage: semanticMsg,
        text,
        fromDevice: event.fromDevice,
        time: Date.now(),
        status: 'received',
        languageDisplay,
        emotionDisplay,
        emotionConfidencePct,
        voiceProfileDisplay,
      };
      setLastReceivedMessage(message);
      setReceivedMessages((prev) => [message, ...prev].slice(0, 20));

      // Mute mic to prevent feedback loop.
      if (!isMutedRef.current) {
        NativeSTT.muteMic();
        isMutedRef.current = true;
      }

      setStatus('SPEAKING');

      // Speak via existing TTS using the text and language from the semantic message.
      const ttsLanguage = semanticMsg?.language ?? 'en';
      NativeTTS.speak(text, ttsLanguage, false)
        .then(() => {
          // Unmute mic after TTS finishes.
          if (isMutedRef.current) {
            NativeSTT.unmuteMic();
            isMutedRef.current = false;
          }
          setStatus(enabled ? 'WAITING_FOR_SPEECH' : 'OFF');
          // Update message status.
          setReceivedMessages((prev) =>
            prev.map((m) =>
              m.time === message.time ? { ...m, status: 'spoken' as const } : m,
            ),
          );
        })
        .catch((err: any) => {
          if (isMutedRef.current) {
            NativeSTT.unmuteMic();
            isMutedRef.current = false;
          }
          setVoiceError(`TTS error: ${err.message || err}`);
          setStatus('ERROR');
        });
    });

    // Handle BLE disconnect while voice mode is on.
    const disconnSub = NativeBLE.onDisconnected(() => {
      if (enabled) {
        setVoiceError('Connection lost');
        setStatus('ERROR');
        setEnabled(false);
        // Unmute if muted.
        if (isMutedRef.current) {
          NativeSTT.unmuteMic();
          isMutedRef.current = false;
        }
      }
    });

    // Handle BLE send failure.
    const sendFailSub = NativeBLE.onSendFailed((event: { error: string }) => {
      if (enabled) {
        setSendStatus('failed');
        setVoiceError(`Send failed: ${event.error}`);
        setStatus('ERROR');
      }
    });

    subsRef.current = [sttResultSub, bleDataSub, disconnSub, sendFailSub];

    return () => {
      subsRef.current.forEach((s) => s.remove());
      subsRef.current = [];
      // Ensure mic is unmuted on cleanup.
      if (isMutedRef.current) {
        NativeSTT.unmuteMic();
        isMutedRef.current = false;
      }
    };
  }, [enabled]);

  // ── Actions ─────────────────────────────────────────────────────────

  const toggleVoiceMode = useCallback(async () => {
    if (enabled) {
      // Turn off.
      setEnabled(false);
      setStatus('OFF');
      setVoiceError(null);
      setLastSentMessage(null);
      // Unmute if muted.
      if (isMutedRef.current) {
        NativeSTT.unmuteMic();
        isMutedRef.current = false;
      }
    } else {
      // Turn on — require BLE connection.
      try {
        const info = await NativeBLE.getConnectionState();
        if (info.state !== 'CONNECTED') {
          setVoiceError('Connect to a device first');
          return;
        }
        setEnabled(true);
        setStatus('WAITING_FOR_SPEECH');
        setVoiceError(null);
        setLastSentMessage(null);
        setSendStatus('idle');
      } catch (e: any) {
        setVoiceError(e.message);
      }
    }
  }, [enabled]);

  const clearError = useCallback(() => {
    setVoiceError(null);
    if (status === 'ERROR') {
      setStatus(enabled ? 'WAITING_FOR_SPEECH' : 'OFF');
    }
  }, [status, enabled]);

  return {
    enabled,
    status,
    lastSentMessage,
    sendStatus,
    lastReceivedMessage,
    receivedMessages,
    voiceError,
    toggleVoiceMode,
    clearError,
  };
}
