import { useState, useEffect, useCallback, useRef } from 'react';
import { NativeEventEmitter, NativeModules } from 'react-native';
import NativeBLE from '../native/NativeBLE';
import NativeSTT from '../native/NativeSTT';
import {
  SemanticMessage,
  createSemanticMessage,
  getLanguageDisplayName,
  capitalizeEmotion,
} from '../semantic';
import {
  encodeUnrestricted,
  decodeWithFallback,
  getEncodedByteLength as binaryGetEncodedByteLength,
  v6bEncode,
  v6bDecode,
  SequenceManager,
  SequenceValidator,
  V6B_FRAME_V6A_MESSAGE,
  V6B_FRAME_ACK,
  V6B_FRAME_NACK,
  V6B_VERSION,
  splitV6A,
  parseHeader,
  Reassembler,
  V7_MARKER,
  V7_HEADER_SIZE,
  ReliabilityManager,
  DeliveredMessageCache,
  CompletedGroupCache,
} from '../protocol';

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

  // V6B transport state
  const seqManagerRef = useRef(new SequenceManager(0));
  const seqValidatorRef = useRef(new SequenceValidator());

  // V7 fragmentation state
  const reassemblerRef = useRef(new Reassembler());
  const cleanupTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // V8 reliability state
  const deliveredCacheRef = useRef(new DeliveredMessageCache());
  const completedGroupCacheRef = useRef(new CompletedGroupCache());
  const reliabilityManagerRef = useRef<ReliabilityManager | null>(null);

  /** Helper: send a V6B frame over BLE. */
  const sendV6BFrame = useCallback(async (frame: Uint8Array): Promise<void> => {
    let charStr = '';
    for (let i = 0; i < frame.length; i++) {
      charStr += String.fromCharCode(frame[i]);
    }
    let base64: string;
    try {
      base64 = (globalThis as any).btoa(charStr);
    } catch {
      base64 = (globalThis as any).btoa(charStr);
    }
    await NativeBLE.send(base64);
  }, []);

  /** Helper: send the initial DATA frames for a PendingMessage (single or fragmented). */
  const sendInitialData = useCallback(async (msg: import('../protocol').PendingMessage): Promise<void> => {
    if (msg.fragments.length === 0) {
      // Single-frame: build one V6B DATA frame
      const seq = seqManagerRef.current.nextSequence();
      const encoded = v6bEncode(seq, V6B_FRAME_V6A_MESSAGE, msg.v6aPacket);
      await sendV6BFrame(encoded);
    } else {
      // Fragmented: send each V7 fragment as a separate V6B DATA frame
      for (let i = 0; i < msg.payloads.length; i++) {
        const seq = seqManagerRef.current.nextSequence();
        const encoded = v6bEncode(seq, V6B_FRAME_V6A_MESSAGE, msg.payloads[i]);
        await sendV6BFrame(encoded);
      }
    }
    // After all DATA frames sent, start the ACK retry timer.
    reliabilityManagerRef.current?.onFrameSent();
  }, [sendV6BFrame]);

  /** Helper: get or create per-peer ReliabilityManager. */
  const getOrCreateReliabilityManager = useCallback((): ReliabilityManager => {
    if (!reliabilityManagerRef.current) {
      const mgr = new ReliabilityManager('local', seqManagerRef.current);
      mgr.setSendFn(async (frame: Uint8Array) => {
        await sendV6BFrame(frame);
      });
      mgr.setOnEvent((event) => {
        if (event.type === 'TIMEOUT_RETRY') {
          console.log(`[BLE Voice] Retransmitting (timeout): ${event.messageId}`);
        } else if (event.type === 'NACK_RECEIVED') {
          console.log(`[BLE Voice] Retransmitting (NACK reason=0x${event.reason?.toString(16)}): ${event.messageId}`);
        } else if (event.type === 'MAX_RETRIES') {
          console.warn(`[BLE Voice] Delivery failed after retries: ${event.messageId}`);
          setVoiceError(`Message delivery failed after retries: ${event.messageId}`);
        } else if (event.type === 'ACK_RECEIVED') {
          console.log(`[BLE Voice] ACK received: ${event.messageId}`);
        } else if (event.type === 'CANCELLED') {
          console.log(`[BLE Voice] Reliability cancelled: ${event.messageId}`);
        }
      });
      // When a queued message is promoted, send its DATA frames.
      mgr.setOnPromote((promotedMsg) => {
        console.log(`[BLE Voice] Queued message promoted: ${promotedMsg.messageId}`);
        sendInitialData(promotedMsg).catch((err: any) => {
          console.warn(`[BLE Voice] Promoted message send failed: ${err}`);
        });
      });
      reliabilityManagerRef.current = mgr;
    }
    return reliabilityManagerRef.current;
  }, [sendV6BFrame, sendInitialData]);

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

          const v6aEncoded = encodeUnrestricted(semanticMsg);
          const byteLen = binaryGetEncodedByteLength(semanticMsg);

          // V7 fragmentation: split if V6A exceeds V6B payload limit
          const fragments = splitV6A(v6aEncoded);

          console.log(
            fragments.length === 0
              ? `[BLE Voice] Sending message ${semanticMsg.messageId} (V6A ${byteLen} bytes): "${transcript}"`
              : `[BLE Voice] Sending fragmented message ${semanticMsg.messageId} (V6A ${byteLen} bytes, ${fragments.length} fragments): "${transcript}"`,
          );

          setLastSentMessage(semanticMsg);
          setStatus('SENDING');
          setSendStatus('idle');

          // V8: register with reliability manager
          const mgr = getOrCreateReliabilityManager();
          const result = mgr.send({
            messageId: semanticMsg.messageId,
            v6aPacket: v6aEncoded,
            groupId: fragments.length > 0 ? fragments[0].header.groupId : 0,
            fragments: fragments.map(f => f.payload),
            payloads: fragments.map(f => f.payload),
          });

          if (fragments.length > 0) {
            mgr.registerGroupId(fragments[0].header.groupId, semanticMsg.messageId);
          }

          if (result.active) {
            // Message became active — send DATA frames now.
            sendInitialData(result.message)
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
            // Message was queued — do NOT send DATA frames.
            // onPromote callback will fire when it's this message's turn.
            console.log(`[BLE Voice] Message ${semanticMsg.messageId} queued (active message pending)`);
          }
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

      // Convert to Uint8Array for binary detection.
      let rawData: Uint8Array | string;
      try {
        const bytes = new Uint8Array(decoded.length);
        for (let i = 0; i < decoded.length; i++) {
          bytes[i] = decoded.charCodeAt(i) & 0xff;
        }
        rawData = bytes;
      } catch {
        rawData = decoded;
      }

      // ── Protocol detection and decode ─────────────────────────
      let semanticMsg = null;

      if (rawData instanceof Uint8Array && rawData.length > 0) {
        const firstByte = rawData[0];

        if (firstByte === V6B_VERSION) {
          // V6B transport envelope → unwrap
          const frame = v6bDecode(rawData);

          // V8: intercept ACK/NACK before DATA processing
          if (frame.frameType === V6B_FRAME_ACK) {
            const ackMsgId = ReliabilityManager.parseAckPayload(frame.payload);
            if (ackMsgId) {
              reliabilityManagerRef.current?.handleAck(ackMsgId);
            }
            return; // ACK is control — stop processing
          }
          if (frame.frameType === V6B_FRAME_NACK) {
            const nackData = ReliabilityManager.parseNackPayload(frame.payload);
            if (nackData) {
              reliabilityManagerRef.current?.handleNack(nackData.groupId, nackData.reason);
            }
            return; // NACK is control — stop processing
          }

          if (frame.frameType === V6B_FRAME_V6A_MESSAGE) {
            // Validate sequence (detect gaps/duplicates, but still process)
            const seqResult = seqValidatorRef.current.validate(
              event.fromDevice,
              frame.sequence,
            );
            if (seqResult.duplicate) {
              console.log(`[BLE Voice] Duplicate sequence ${frame.sequence} from ${event.fromDevice}, still processing`);
            }
            if (seqResult.gap) {
              console.log(`[BLE Voice] Sequence gap detected: ${frame.sequence} from ${event.fromDevice}`);
            }

            // Check V6B payload for V7 fragmentation marker
            if (frame.payload.length > 0 && frame.payload[0] === V7_MARKER) {
              // V7 fragment → parse header
              try {
                const header = parseHeader(frame.payload);

                // V8: check CompletedGroupCache BEFORE Reassembler
                // Prevents re-creating reassembly state for already-completed groups.
                const cachedMsgId = completedGroupCacheRef.current.getCompletedMessageId(
                  event.fromDevice,
                  header.groupId,
                );
                if (cachedMsgId) {
                  // Group already completed — re-send ACK using cached messageId, no TTS
                  const ackPayload = ReliabilityManager.buildAckPayload(cachedMsgId);
                  const ackFrame = v6bEncode(
                    seqManagerRef.current.nextSequence(),
                    V6B_FRAME_ACK,
                    ackPayload,
                  );
                  sendV6BFrame(ackFrame).catch(() => {});
                  console.log(`[BLE Voice] Completed group ${header.groupId} — re-ACKed, skipped reassembly`);
                } else {
                  // Group not yet completed — pass to Reassembler
                  const v6aChunk = frame.payload.slice(V7_HEADER_SIZE);
                  const result = reassemblerRef.current.addFragment(
                    event.fromDevice,
                    header,
                    v6aChunk,
                  );

                  if (result.status === 'complete') {
                    semanticMsg = decodeWithFallback(result.v6aPacket);
                    // V8: semantic deduplication for V7
                    if (semanticMsg) {
                      const msgId = semanticMsg.messageId;
                      const groupId = header.groupId;

                      if (deliveredCacheRef.current.isDelivered(event.fromDevice, msgId)) {
                        // MessageId already delivered — re-send ACK, block TTS
                        const ackPayload = ReliabilityManager.buildAckPayload(msgId);
                        const ackFrame = v6bEncode(
                          seqManagerRef.current.nextSequence(),
                          V6B_FRAME_ACK,
                          ackPayload,
                        );
                        sendV6BFrame(ackFrame).catch(() => {});
                        semanticMsg = null; // block TTS
                      } else {
                        // New delivery — mark delivered, store completed group, send ACK
                        deliveredCacheRef.current.markDelivered(event.fromDevice, msgId);
                        completedGroupCacheRef.current.store(event.fromDevice, groupId, msgId);
                        const ackPayload = ReliabilityManager.buildAckPayload(msgId);
                        const ackFrame = v6bEncode(
                          seqManagerRef.current.nextSequence(),
                          V6B_FRAME_ACK,
                          ackPayload,
                        );
                        sendV6BFrame(ackFrame).catch(() => {});
                      }
                    }
                  } else if (result.status === 'error') {
                    console.warn(`[BLE Voice] V7 reassembly error: ${result.reason}`);
                  }
                  // else: incomplete — wait for more fragments
                }
              } catch (e: any) {
                console.warn(`[BLE Voice] V7 fragment parse error: ${e.message}`);
              }
            } else {
              // Single-frame V6A (no V7 header)
              semanticMsg = decodeWithFallback(frame.payload);
              // V8: semantic deduplication for single-frame
              if (semanticMsg) {
                const msgId = semanticMsg.messageId;
                if (deliveredCacheRef.current.isDelivered(event.fromDevice, msgId)) {
                  // Already delivered — re-send ACK, block TTS
                  const ackPayload = ReliabilityManager.buildAckPayload(msgId);
                  const ackFrame = v6bEncode(
                    seqManagerRef.current.nextSequence(),
                    V6B_FRAME_ACK,
                    ackPayload,
                  );
                  sendV6BFrame(ackFrame).catch(() => {});
                  semanticMsg = null; // block TTS
                } else {
                  // New delivery — mark delivered, send ACK
                  deliveredCacheRef.current.markDelivered(event.fromDevice, msgId);
                  const ackPayload = ReliabilityManager.buildAckPayload(msgId);
                  const ackFrame = v6bEncode(
                    seqManagerRef.current.nextSequence(),
                    V6B_FRAME_ACK,
                    ackPayload,
                  );
                  sendV6BFrame(ackFrame).catch(() => {});
                }
              }
            }
          }
        } else if (firstByte === 0x02) {
          // V6A binary (no V6B envelope) — backward compatibility
          semanticMsg = decodeWithFallback(rawData);
        } else if (firstByte === 0x7b) {
          // V4 JSON — backward compatibility
          semanticMsg = decodeWithFallback(rawData);
        }
        // else: unknown format, semanticMsg remains null
      } else if (typeof rawData === 'string') {
        // String input — attempt V4 JSON decode
        semanticMsg = decodeWithFallback(rawData);
      }

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
        // V8: clear reliability state
        reliabilityManagerRef.current?.cancel();
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

  // ── V7 reassembly cleanup timer ──────────────────────────────────

  useEffect(() => {
    if (enabled) {
      cleanupTimerRef.current = setInterval(() => {
        reassemblerRef.current.cleanup();
      }, 10_000);
    }
    return () => {
      if (cleanupTimerRef.current) {
        clearInterval(cleanupTimerRef.current);
        cleanupTimerRef.current = null;
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
