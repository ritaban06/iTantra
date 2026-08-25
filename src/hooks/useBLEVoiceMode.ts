import { useState, useEffect, useCallback, useRef } from 'react';
import { NativeEventEmitter, NativeModules } from 'react-native';
import NativeBLE from '../native/NativeBLE';
import NativeSTT from '../native/NativeSTT';

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

export interface BLEVoiceMessage {
  text: string;
  fromDevice: string;
  time: number;
  status: 'received' | 'speaking' | 'spoken';
}

/**
 * Integration hook that connects STT → BLE → TTS.
 *
 * When BLE Voice Mode is enabled:
 * - Final STT transcripts are sent to the connected peer via BLE.
 * - Received BLE text is spoken via TTS.
 * - Mic is muted during TTS playback to prevent feedback loops.
 */
export function useBLEVoiceMode() {
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<BLEVoiceModeStatus>('OFF');
  const [lastSentText, setLastSentText] = useState<string | null>(null);
  const [sendStatus, setSendStatus] = useState<'idle' | 'sent' | 'failed'>('idle');
  const [lastReceivedMessage, setLastReceivedMessage] = useState<BLEVoiceMessage | null>(null);
  const [receivedMessages, setReceivedMessages] = useState<BLEVoiceMessage[]>([]);
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const subsRef = useRef<Array<{ remove: () => void }>>([]);
  const isMutedRef = useRef(false);

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
          if (info.state === 'CONNECTED') {
            // Send via BLE.
            setLastSentText(transcript);
            setStatus('SENDING');
            setSendStatus('idle');

            let encoded: string;
            try {
              encoded = (globalThis as any).btoa(transcript);
            } catch {
              const bytes = [] as number[];
              for (let i = 0; i < transcript.length; i++) {
                const code = transcript.charCodeAt(i);
                if (code < 0x80) bytes.push(code);
                else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
                else bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
              }
              encoded = (globalThis as any).btoa(String.fromCharCode(...bytes));
            }

            NativeBLE.send(encoded)
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
          } else {
            // Not connected — don't send.
            setVoiceError('Not connected to a device');
          }
        });
      }
    });

    // When BLE data is received, speak it via TTS.
    const bleDataSub = NativeBLE.onDataReceived((event: { data: string; fromDevice: string }) => {
      let decoded: string;
      try {
        decoded = (globalThis as any).atob(event.data);
      } catch {
        decoded = event.data;
      }

      if (!decoded.trim()) return;

      const message: BLEVoiceMessage = {
        text: decoded,
        fromDevice: event.fromDevice,
        time: Date.now(),
        status: 'received',
      };
      setLastReceivedMessage(message);
      setReceivedMessages((prev) => [message, ...prev].slice(0, 20));

      // Mute mic to prevent feedback loop.
      if (!isMutedRef.current) {
        NativeSTT.muteMic();
        isMutedRef.current = true;
      }

      setStatus('SPEAKING');

      // Speak via existing TTS.
      NativeTTS.speak(decoded, 'en', false)
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
        setLastSentText(null);
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
    lastSentText,
    sendStatus,
    lastReceivedMessage,
    receivedMessages,
    voiceError,
    toggleVoiceMode,
    clearError,
  };
}
