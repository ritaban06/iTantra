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
  hashMessageId,
  v6bEncode,
  v6bDecode,
  SequenceManager,
  SequenceValidator,
  V6B_FRAME_V6A_MESSAGE,
  V6B_FRAME_BITCHAT,
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
import {
  BitChatBLEAdapter,
  NodeIdStore,
  normalizeNodeId,
  normalizePacketId,
  NODE_ID_BROADCAST,
  PROTOCOL_VERSION as BITCHAT_PROTOCOL_VERSION,
} from '../BITCHAT';

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
 * Per-BLE-peer V8 reliability state.
 *
 * V9E Step 6: each BLE peer (keyed by its iTantra deviceId) owns an
 * independent SequenceManager and ReliabilityManager so that sequence
 * state, pending messages, retry timers, ACK/NACK handling, and
 * retransmissions are isolated per BLE link. V8 remains per-hop
 * transport reliability — there is no mesh-level ACK/NACK.
 */
interface PeerReliabilityState {
  manager: ReliabilityManager;
  seqManager: SequenceManager;
}

// ── Voice destination store (V9E Step 10) ─────────────────────────────
//
// The voice destination is a BITCHAT node ID (logical mesh identity), NOT a
// Bluetooth deviceId. It may be a directly connected peer, a node several
// hops away (discovered via V9D), or NODE_ID_BROADCAST.
//
// The store lives in voiceDestinationStore.ts (dependency-free) so screens
// like ConnectScreen can share the selected destination without pulling in
// the whole voice-mode stack. Re-exported here for backward compatibility.

import {
  getVoiceDestinationNodeId,
  setVoiceDestinationNodeId,
  subscribeVoiceDestination,
  registerMeshDestinationsProvider,
  notifyMeshDestinationsChanged,
  type VoiceDestination,
  type MeshDestination,
} from './voiceDestinationStore';

export {
  getVoiceDestinationNodeId,
  setVoiceDestinationNodeId,
  subscribeVoiceDestination,
  registerMeshDestinationsProvider,
  getMeshDestinations,
  subscribeMeshDestinations,
  notifyMeshDestinationsChanged,
  resetVoiceDestinationStore,
} from './voiceDestinationStore';
export type { VoiceDestination, MeshDestination } from './voiceDestinationStore';

/** Convert raw bytes to a Base64 string for the native bridge. */
function bytesToBase64(bytes: Uint8Array): string {
  let charStr = '';
  for (let i = 0; i < bytes.length; i++) {
    charStr += String.fromCharCode(bytes[i]);
  }
  return (globalThis as any).btoa(charStr);
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

  // V9E Step 10: the logical BITCHAT destination for voice-originated
  // packets (a nodeId or NODE_ID_BROADCAST) — never a Bluetooth deviceId.
  const [voiceDestinationNodeId, setVoiceDestinationNodeIdState] =
    useState<VoiceDestination>(getVoiceDestinationNodeId());

  const subsRef = useRef<Array<{ remove: () => void }>>([]);
  const isMutedRef = useRef(false);
  const languageCodeRef = useRef(languageCode);

  // Inbound sequence validation — SequenceValidator is keyed by source
  // device internally, so a single instance stays correct across peers.
  const seqValidatorRef = useRef(new SequenceValidator());

  // V7 fragmentation state
  const reassemblerRef = useRef(new Reassembler());
  const cleanupTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // V8 reliability state — per BLE peer (V9E Step 6).
  const deliveredCacheRef = useRef(new DeliveredMessageCache());
  const completedGroupCacheRef = useRef(new CompletedGroupCache());
  const peerReliabilityRef = useRef<Map<string, PeerReliabilityState>>(new Map());

  // V9C BITCHAT mesh state
  const nodeIdStoreRef = useRef<NodeIdStore | null>(null);
  const bitchatAdapterRef = useRef<BitChatBLEAdapter | null>(null);
  // Peers that already received our direct ANNOUNCE on their current BLE
  // connection. Cleared when that peer disconnects so a reconnect re-announces.
  const announcedPeersRef = useRef<Set<string>>(new Set());

  /** Simple AsyncStorage-compatible storage for NodeIdStore. */
  const storageBackend = useRef({
    getItem: async (key: string): Promise<string | null> => {
      try { return await NativeModules?.AsyncStorage?.getItem(key) ?? null; } catch { return null; }
    },
    setItem: async (key: string, value: string): Promise<void> => {
      try { await NativeModules?.AsyncStorage?.setItem(key, value); } catch { /* ignore */ }
    },
  }).current;

  /** Helper: send a V6B frame to a SPECIFIC BLE peer (peer-targeted). */
  const sendV6BFrameToPeer = useCallback(async (frame: Uint8Array, deviceId: string): Promise<void> => {
    await NativeBLE.send(bytesToBase64(frame), deviceId);
  }, []);

  /**
   * Ref to the current sendInitialData implementation, so the
   * getOrCreatePeerReliability() onPromote callback can always dispatch a
   * promoted message with the freshest send helper.
   */
  const sendInitialDataRef = useRef<
    (msg: import('../protocol').PendingMessage, deviceId: string) => Promise<void>
  >(async () => {});

  /**
   * Get or create the per-peer V8 reliability state for a BLE peer.
   *
   * Each peer gets its own ReliabilityManager and SequenceManager. The
   * manager's sendFn and event/promote callbacks are bound to THIS peer,
   * so retransmissions always target the correct BLE peer via
   * NativeBLE.send(frame, deviceId).
   */
  const getOrCreatePeerReliability = useCallback((deviceId: string): PeerReliabilityState => {
    const existing = peerReliabilityRef.current.get(deviceId);
    if (existing) return existing;

    const seqManager = new SequenceManager(0);
    const mgr = new ReliabilityManager(deviceId, seqManager);
    mgr.setSendFn(async (frame: Uint8Array) => {
      // Retransmissions from this manager go to THIS peer only.
      await sendV6BFrameToPeer(frame, deviceId);
    });
    mgr.setOnEvent((event) => {
      if (event.type === 'TIMEOUT_RETRY') {
        console.log(`[BLE Voice] Retransmitting to ${deviceId} (timeout): ${event.messageId}`);
      } else if (event.type === 'NACK_RECEIVED') {
        console.log(`[BLE Voice] Retransmitting to ${deviceId} (NACK reason=0x${event.reason?.toString(16)}): ${event.messageId}`);
      } else if (event.type === 'MAX_RETRIES') {
        console.warn(`[BLE Voice] Delivery to ${deviceId} failed after retries: ${event.messageId}`);
        setVoiceError(`Message delivery to ${deviceId} failed after retries: ${event.messageId}`);
      } else if (event.type === 'ACK_RECEIVED') {
        console.log(`[BLE Voice] ACK received from ${deviceId}: ${event.messageId}`);
      } else if (event.type === 'CANCELLED') {
        console.log(`[BLE Voice] Reliability cancelled for ${deviceId}: ${event.messageId}`);
      }
    });
    // When this peer's queued message is promoted, send its DATA frames
    // to this same peer, then let onFrameSent start its retry timer.
    mgr.setOnPromote((promotedMsg) => {
      console.log(`[BLE Voice] Queued message promoted for ${deviceId}: ${promotedMsg.messageId}`);
      sendInitialDataRef.current(promotedMsg, deviceId).catch((err: any) => {
        console.warn(`[BLE Voice] Promoted message send failed for ${deviceId}: ${err}`);
      });
    });
    const state: PeerReliabilityState = { manager: mgr, seqManager };
    peerReliabilityRef.current.set(deviceId, state);
    return state;
  }, [sendV6BFrameToPeer]);

  /** Helper: send the initial DATA frames for a PendingMessage to a specific peer. */
  const sendInitialData = useCallback(async (
    msg: import('../protocol').PendingMessage,
    deviceId: string,
  ): Promise<void> => {
    const { manager, seqManager } = getOrCreatePeerReliability(deviceId);
    if (msg.fragments.length === 0) {
      // Single-frame: build one V6B DATA frame
      const seq = seqManager.nextSequence();
      const encoded = v6bEncode(seq, V6B_FRAME_V6A_MESSAGE, msg.v6aPacket);
      await sendV6BFrameToPeer(encoded, deviceId);
    } else {
      // Fragmented: send each V7 fragment as a separate V6B DATA frame
      for (let i = 0; i < msg.payloads.length; i++) {
        const seq = seqManager.nextSequence();
        const encoded = v6bEncode(seq, V6B_FRAME_V6A_MESSAGE, msg.payloads[i]);
        await sendV6BFrameToPeer(encoded, deviceId);
      }
    }
    // After all DATA frames sent, start the ACK retry timer for THIS peer's manager.
    manager.onFrameSent();
  }, [getOrCreatePeerReliability, sendV6BFrameToPeer]);

  // Keep the ref current so per-peer onPromote callbacks use the latest helper.
  sendInitialDataRef.current = sendInitialData;

  /**
   * Send an ACK for a received message back to the BLE peer it came from.
   *
   * The ACK sequence is drawn from that peer's own SequenceManager so each
   * BLE link keeps an independent outbound sequence stream.
   */
  const sendAckToPeer = useCallback((toPeerId: string, messageId: string) => {
    // Loopback/local deliveries without a real BLE peer must not be ACKed.
    if (!toPeerId || toPeerId === 'unknown') return;
    const { seqManager } = getOrCreatePeerReliability(toPeerId);
    const ackFrame = v6bEncode(
      seqManager.nextSequence(),
      V6B_FRAME_ACK,
      ReliabilityManager.buildAckPayload(messageId),
    );
    sendV6BFrameToPeer(ackFrame, toPeerId).catch(() => {});
  }, [getOrCreatePeerReliability, sendV6BFrameToPeer]);

  /** Route an incoming ACK to the ReliabilityManager of the peer that sent it. */
  const routeAckFromPeer = useCallback((fromPeerId: string, messageId: string) => {
    peerReliabilityRef.current.get(fromPeerId)?.manager.handleAck(messageId);
  }, []);

  /** Route an incoming NACK to the ReliabilityManager of the peer that sent it. */
  const routeNackFromPeer = useCallback((fromPeerId: string, groupId: number, reason: number) => {
    peerReliabilityRef.current.get(fromPeerId)?.manager.handleNack(groupId, reason);
  }, []);

  /**
   * Process a V6B payload through the existing decode pipeline.
   * Used by both direct V6B reception and BITCHAT local delivery.
   *
   * All V8 state access is scoped to `fromPeerId` so one peer's
   * ACK/NACK/data can never affect another peer's reliability state.
   */
  const processV6BPayload = useCallback((v6bPayload: Uint8Array, fromPeerId: string) => {
    let semanticMsg = null;

    if (v6bPayload.length > 0 && v6bPayload[0] === V6B_VERSION) {
      const frame = v6bDecode(v6bPayload);

      // V8: intercept ACK/NACK — route to the sender's per-peer manager.
      if (frame.frameType === V6B_FRAME_ACK) {
        const ackMsgId = ReliabilityManager.parseAckPayload(frame.payload);
        if (ackMsgId) routeAckFromPeer(fromPeerId, ackMsgId);
        return;
      }
      if (frame.frameType === V6B_FRAME_NACK) {
        const nackData = ReliabilityManager.parseNackPayload(frame.payload);
        if (nackData) routeNackFromPeer(fromPeerId, nackData.groupId, nackData.reason);
        return;
      }

      if (frame.frameType === V6B_FRAME_V6A_MESSAGE) {
        const seqResult = seqValidatorRef.current.validate(fromPeerId, frame.sequence);
        if (seqResult.duplicate) {
          console.log(`[BLE Voice] Duplicate sequence ${frame.sequence} from ${fromPeerId}`);
        }

        if (frame.payload.length > 0 && frame.payload[0] === V7_MARKER) {
          try {
            const header = parseHeader(frame.payload);
            const cachedMsgId = completedGroupCacheRef.current.getCompletedMessageId(fromPeerId, header.groupId);
            if (cachedMsgId) {
              sendAckToPeer(fromPeerId, cachedMsgId);
            } else {
              const v6aChunk = frame.payload.slice(V7_HEADER_SIZE);
              const result = reassemblerRef.current.addFragment(fromPeerId, header, v6aChunk);
              if (result.status === 'complete') {
                semanticMsg = decodeWithFallback(result.v6aPacket);
                if (semanticMsg) {
                  const msgId = semanticMsg.messageId;
                  const groupId = header.groupId;
                  if (deliveredCacheRef.current.isDelivered(fromPeerId, msgId)) {
                    sendAckToPeer(fromPeerId, msgId);
                    semanticMsg = null;
                  } else {
                    deliveredCacheRef.current.markDelivered(fromPeerId, msgId);
                    completedGroupCacheRef.current.store(fromPeerId, groupId, msgId);
                    sendAckToPeer(fromPeerId, msgId);
                  }
                }
              } else if (result.status === 'error') {
                console.warn(`[BLE Voice] V7 reassembly error: ${result.reason}`);
              }
            }
          } catch (e: any) {
            console.warn(`[BLE Voice] V7 fragment parse error: ${e.message}`);
          }
        } else {
          semanticMsg = decodeWithFallback(frame.payload);
          if (semanticMsg) {
            const msgId = semanticMsg.messageId;
            if (deliveredCacheRef.current.isDelivered(fromPeerId, msgId)) {
              sendAckToPeer(fromPeerId, msgId);
              semanticMsg = null;
            } else {
              deliveredCacheRef.current.markDelivered(fromPeerId, msgId);
              sendAckToPeer(fromPeerId, msgId);
            }
          }
        }
      }
    } else if (v6bPayload.length > 0 && v6bPayload[0] === 0x02) {
      semanticMsg = decodeWithFallback(v6bPayload);
    } else if (v6bPayload.length > 0 && v6bPayload[0] === 0x7b) {
      semanticMsg = decodeWithFallback(v6bPayload);
    }

    // Build message for UI
    let text = '';
    let languageDisplay = 'Unknown';
    let emotionDisplay = 'Unknown';
    let emotionConfidencePct = 0;
    let voiceProfileDisplay = 'Unknown';

    if (semanticMsg) {
      text = semanticMsg.text;
      languageDisplay = getLanguageDisplayName(semanticMsg.language);
      emotionDisplay = capitalizeEmotion(semanticMsg.emotion);
      emotionConfidencePct = Math.round(semanticMsg.emotionConfidence * 100);
      voiceProfileDisplay = semanticMsg.voiceProfile;
      console.log(`[BLE Voice] Received message ${semanticMsg.messageId} from ${fromPeerId}: "${text}"`);
    } else {
      console.warn(`[BLE Voice] Unparseable data from ${fromPeerId}`);
      return;
    }

    const message: BLEVoiceMessage = {
      semanticMessage: semanticMsg, text, fromDevice: fromPeerId, time: Date.now(),
      status: 'received', languageDisplay, emotionDisplay, emotionConfidencePct, voiceProfileDisplay,
    };
    setLastReceivedMessage(message);
    setReceivedMessages((prev) => [message, ...prev].slice(0, 20));

    if (!isMutedRef.current) { NativeSTT.muteMic(); isMutedRef.current = true; }
    setStatus('SPEAKING');
    const ttsLanguage = semanticMsg?.language ?? 'en';
    NativeTTS.speak(text, ttsLanguage, false)
      .then(() => {
        if (isMutedRef.current) { NativeSTT.unmuteMic(); isMutedRef.current = false; }
        setStatus(enabled ? 'WAITING_FOR_SPEECH' : 'OFF');
        setReceivedMessages((prev) => prev.map((m) => m.time === message.time ? { ...m, status: 'spoken' as const } : m));
      })
      .catch((err: any) => {
        if (isMutedRef.current) { NativeSTT.unmuteMic(); isMutedRef.current = false; }
        setVoiceError(`TTS error: ${err.message || err}`);
        setStatus('ERROR');
      });
  }, [enabled, routeAckFromPeer, routeNackFromPeer, sendAckToPeer]);

  /** Initialize or get the BITCHAT adapter. */
  const getOrCreateAdapter = useCallback(async (): Promise<BitChatBLEAdapter> => {
    if (bitchatAdapterRef.current) return bitchatAdapterRef.current;

    // Get or create NodeIdStore
    if (!nodeIdStoreRef.current) {
      nodeIdStoreRef.current = new NodeIdStore(storageBackend);
    }
    const localNodeId = await nodeIdStoreRef.current.getLocalNodeId();

    // Create adapter
    const adapter = new BitChatBLEAdapter({
      localNodeId,
      bleSend: async (peerBleId: string, payload: Uint8Array) => {
        // V9C: Wrap BITCHAT envelope in V6B for per-hop transport framing.
        // V9E Step 6: each BLE peer has its own SequenceManager, and the
        // frame is sent with peer targeting (never the legacy no-peer path).
        const { seqManager } = getOrCreatePeerReliability(peerBleId);
        const seq = seqManager.nextSequence();
        const v6bFrame = v6bEncode(seq, V6B_FRAME_BITCHAT, payload);
        await NativeBLE.send(bytesToBase64(v6bFrame), peerBleId);
      },
      onLocalDeliver: (v6bPayload: Uint8Array, fromPeerId?: string) => {
        // Pass the V6B payload to the existing decode pipeline
        processV6BPayload(v6bPayload, fromPeerId ?? 'unknown');
      },
    });
    bitchatAdapterRef.current = adapter;
    return adapter;
  }, [storageBackend, getOrCreatePeerReliability, processV6BPayload]);

  /**
   * Send our direct-link ANNOUNCE to a BLE peer (once per connection).
   *
   * V9E Step 9: ANNOUNCE is connection-scoped, NOT voice-mode-scoped. It is
   * sent when a peer connection is established regardless of whether voice
   * mode is on, so mesh/relay identity discovery is independent of voice.
   */
  const sendAnnounceToPeer = useCallback(async (peerId: string): Promise<void> => {
    if (announcedPeersRef.current.has(peerId)) return;
    const adapter = bitchatAdapterRef.current;
    if (!adapter) return;
    const announcePkt = adapter.createAnnouncePacket();
    const { seqManager } = getOrCreatePeerReliability(peerId);
    const v6bFrame = v6bEncode(seqManager.nextSequence(), V6B_FRAME_BITCHAT, announcePkt);
    try {
      await NativeBLE.send(bytesToBase64(v6bFrame), peerId);
      announcedPeersRef.current.add(peerId);
      console.log(`[BLE Voice] BITCHAT ANNOUNCE sent to ${peerId} (nodeId: ${adapter.getLocalNodeId()})`);
    } catch {
      console.warn(`[BLE Voice] BITCHAT ANNOUNCE send failed to ${peerId}`);
    }
  }, [getOrCreatePeerReliability]);

  // Keep the hook's React state in sync with the shared destination store.
  useEffect(() => {
    const unsub = subscribeVoiceDestination((dest) => {
      setVoiceDestinationNodeIdState(dest);
    });
    // Pick up changes made before this hook mounted.
    setVoiceDestinationNodeIdState(getVoiceDestinationNodeId());
    return unsub;
  }, []);

  /** Set the voice destination (BITCHAT nodeId or broadcast). */
  const setVoiceDestination = useCallback((destinationNodeId: string) => {
    setVoiceDestinationNodeId(destinationNodeId);
  }, []);

  /**
   * Build the current selectable mesh destinations: directly connected
   * peers (from the adapter's PeerRegistry) plus V9D-discovered nodes
   * (from MeshDiscoveryRegistry). Returns BITCHAT nodeIds — never
   * Bluetooth deviceIds as logical destinations.
   */
  const buildMeshDestinations = useCallback((): MeshDestination[] => {
    const adapter = bitchatAdapterRef.current;
    if (!adapter) return [];
    const direct = adapter.getConnectedPeers().map((nodeId) => ({
      nodeId,
      direct: true,
      blePeerId: adapter.getBlePeerForNodeId(nodeId),
    }));
    const discovered = adapter.getDiscoveredNodes().map((n) => ({
      nodeId: n.nodeId,
      direct: adapter.isDirectPeer(n.nodeId),
      blePeerId: adapter.isDirectPeer(n.nodeId)
        ? adapter.getBlePeerForNodeId(n.nodeId)
        : undefined,
    }));
    const seen = new Set<string>();
    return [...direct, ...discovered].filter((d) => {
      if (seen.has(d.nodeId)) return false;
      seen.add(d.nodeId);
      return true;
    });
  }, []);

  // Keep languageCode ref current for event handlers.
  languageCodeRef.current = languageCode;

  // ── Subscribe to STT and BLE events ────────────────────────────────

  useEffect(() => {
    const sttEmitter = new NativeEventEmitter(NativeSTTModule);

    // When a final STT result arrives and voice mode is on, send via BLE.
    const sttResultSub = sttEmitter.addListener('STT_RESULT', async (event: any) => {
      if (!enabled) return;

      const transcript = event.transcript?.trim();
      if (!transcript) return;

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

      // The 64-bit FNV-1a hash of the string messageId is what actually
      // travels on the wire (the receiver decodes it back as a hex
      // string). It doubles as a stable BITCHAT packetId for the mesh path.
      const compactHash = hashMessageId(semanticMsg.messageId);

      const markSent = (): void => {
        setSendStatus('sent');
        setStatus('SENT');
        setTimeout(() => {
          if (enabled) setStatus('WAITING_FOR_SPEECH');
        }, 1500);
      };
      const markFailed = (err: any): void => {
        setSendStatus('failed');
        setVoiceError(`Send failed: ${err.message || err}`);
        setStatus('ERROR');
      };

      // V9E Step 10: the destination is a BITCHAT nodeId (logical mesh
      // identity), NEVER a Bluetooth deviceId. It may be a directly
      // connected peer, a multi-hop node, or NODE_ID_BROADCAST. Voice
      // origination no longer asks the native layer for a "primary
      // connected peer" — BITCHAT routing handles forwarding.
      const destinationNodeId = getVoiceDestinationNodeId();
      const adapter = bitchatAdapterRef.current;
      const meshMode = !!(adapter && v6aEncoded.length > 0);

      if (meshMode) {
        // V9C/V9E mesh mode — this is the ONLY application send path for
        // this logical message (no duplicate direct-V6B send). The BITCHAT
        // adapter originates the packet ADDRESSED to destinationNodeId;
        // RelayEngine/MeshRouter selects the connected peers and the
        // adapter's per-peer bleSend transmits one V6B_FRAME_BITCHAT frame
        // per BLE peer through that peer's own V8/sequence state. A
        // multi-hop destination simply floods with that destination — no
        // direct BLE connection to the destination node is required.
        //
        // V8 reliable-message registration is intentionally NOT used for
        // BITCHAT frames: hop frames are best-effort transport and have no
        // per-hop ACK loop (mesh-level ACKs are out of scope), so
        // registering would leave the message pending/queued forever.
        const doSend = async (): Promise<void> => {
          await adapter!.originate(
            v6aEncoded,
            normalizePacketId(compactHash),
            destinationNodeId,
          );
        };
        doSend().then(markSent).catch(markFailed);
        return;
      }

      // Direct V6B + V8 fallback (no BITCHAT adapter available — legacy
      // transport path). Prefer the directly connected peer matching the
      // logical destination; otherwise use any connected BLE peer. Without
      // BITCHAT there is no mesh to route through, so the legacy
      // connection view is the only transport target. When BITCHAT is
      // active (meshMode above), this branch is never reached and no
      // legacy connection-state lookup happens.
      const targetPeerId = await (async (): Promise<string | undefined> => {
        if (adapter) {
          const connected = adapter.getConnectedPeers();
          if (destinationNodeId !== NODE_ID_BROADCAST) {
            const blePeer = adapter.getBlePeerForNodeId(destinationNodeId);
            if (blePeer) return blePeer;
          }
          if (connected.length > 0) return connected[0];
        }
        // Legacy direct transport (no BITCHAT adapter): the only possible
        // target is the currently connected BLE peer from the native
        // connection view. Used solely by the pre-mesh direct path.
        try {
          const info = await NativeBLE.getConnectionState();
          if (info.state === 'CONNECTED' && info.deviceId) return info.deviceId;
        } catch {
          /* ignore */
        }
        return undefined;
      })();
      if (!targetPeerId) {
        setVoiceError('Not connected to a device');
        return;
      }

      // Direct V6B + V8 path (no BITCHAT adapter): register with the
      // per-peer reliability manager for this BLE peer.
      //
      // IMPORTANT: ACKs reference the decoded hex form of the message
      // hash, so the reliability manager must track that canonical id —
      // otherwise ACKs can never match the pending message.
      const reliableMessageId = `0x${compactHash.toString(16).padStart(16, '0')}`;
      const { manager: mgr } = getOrCreatePeerReliability(targetPeerId);
      const result = mgr.send({
        messageId: reliableMessageId,
        v6aPacket: v6aEncoded,
        groupId: fragments.length > 0 ? fragments[0].header.groupId : 0,
        fragments: fragments.map(f => f.payload),
        payloads: fragments.map(f => f.payload),
      });

      if (fragments.length > 0) {
        mgr.registerGroupId(fragments[0].header.groupId, reliableMessageId);
      }

      if (result.active) {
        // Direct mode: send V6B frames to the target peer with V8 reliability.
        const doSend = async (): Promise<void> => {
          await sendInitialData(result.message, targetPeerId);
        };
        doSend().then(markSent).catch(markFailed);
      } else {
        // Message was queued — do NOT send DATA frames.
        // onPromote callback will fire when it's this message's turn.
        console.log(`[BLE Voice] Message ${semanticMsg.messageId} queued (active message pending)`);
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
          // V6B transport envelope → unwrap. Malformed/unsupported frames
          // are dropped safely (Audit 9): never crash the receive path,
          // never feed garbage into TTS or the mesh.
          let frame;
          try {
            frame = v6bDecode(rawData);
          } catch (e: any) {
            console.warn(`[BLE Voice] Malformed V6B frame dropped: ${e.message}`);
            return;
          }

          // V8: intercept ACK/NACK before DATA processing — route to the
          // per-peer manager of the device that sent the frame.
          if (frame.frameType === V6B_FRAME_ACK) {
            const ackMsgId = ReliabilityManager.parseAckPayload(frame.payload);
            if (ackMsgId) {
              routeAckFromPeer(event.fromDevice, ackMsgId);
            }
            return; // ACK is control — stop processing
          }
          if (frame.frameType === V6B_FRAME_NACK) {
            const nackData = ReliabilityManager.parseNackPayload(frame.payload);
            if (nackData) {
              routeNackFromPeer(event.fromDevice, nackData.groupId, nackData.reason);
            }
            return; // NACK is control — stop processing
          }

          // V9C: BITCHAT mesh packet carried inside V6B frame
          if (frame.frameType === V6B_FRAME_BITCHAT) {
            const adapter = bitchatAdapterRef.current;
            if (adapter) {
              // frame.payload is the raw BITCHAT envelope
              adapter.receive(frame.payload, event.fromDevice).catch(() => {});
              // V9E Step 10: an incoming ANNOUNCE/DISCOVERY may have
              // changed the known mesh destinations — notify subscribers.
              notifyMeshDestinationsChanged();
            }
            return; // BITCHAT handles delivery/relay — stop further processing
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
                  sendAckToPeer(event.fromDevice, cachedMsgId);
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
                        sendAckToPeer(event.fromDevice, msgId);
                        semanticMsg = null; // block TTS
                      } else {
                        // New delivery — mark delivered, store completed group, send ACK
                        deliveredCacheRef.current.markDelivered(event.fromDevice, msgId);
                        completedGroupCacheRef.current.store(event.fromDevice, groupId, msgId);
                        sendAckToPeer(event.fromDevice, msgId);
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
                  sendAckToPeer(event.fromDevice, msgId);
                  semanticMsg = null; // block TTS
                } else {
                  // New delivery — mark delivered, send ACK
                  deliveredCacheRef.current.markDelivered(event.fromDevice, msgId);
                  sendAckToPeer(event.fromDevice, msgId);
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

      // V9E Step 7: raw BITCHAT control bytes (ANNOUNCE from legacy/older
      // senders that was not V6B-wrapped) are routed into the adapter so the
      // direct BLE peer mapping is registered. Such packets are control
      // traffic and must NEVER reach the voice/TTS pipeline as content.
      if (
        !semanticMsg &&
        rawData instanceof Uint8Array &&
        rawData.length > 0 &&
        rawData[0] === BITCHAT_PROTOCOL_VERSION
      ) {
        const adapter = bitchatAdapterRef.current;
        if (adapter) {
          adapter.receive(rawData, event.fromDevice).catch(() => {});
        }
        return; // BITCHAT control — stop further processing
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
        // Hardening (Step 11, Audit 9): binary garbage — truncated frames
        // or non-protocol bytes laden with control characters — must NEVER
        // be spoken. Only printable text (any script; control chars like
        // NUL/ESC are absent) falls through to TTS, preserving the legacy
        // plain-text path for real legacy text senders.
        if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(decoded)) {
          console.warn(
            `[BLE Voice] Unparseable non-text data from ${event.fromDevice}, dropped`,
          );
          return;
        }
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
    const disconnSub = NativeBLE.onDisconnected((event: { deviceId: string }) => {
      // V9E Step 6: per-peer V8 cleanup — only the disconnected peer's
      // reliability state is cancelled/removed. Other peers are untouched.
      const disconnectedPeerId = event?.deviceId;
      const peerState = disconnectedPeerId
        ? peerReliabilityRef.current.get(disconnectedPeerId)
        : undefined;
      if (peerState) {
        peerState.manager.cancel();
        peerReliabilityRef.current.delete(disconnectedPeerId);
      }
      // Reset inbound sequence tracking for this source on disconnect.
      if (disconnectedPeerId) {
        seqValidatorRef.current.reset(disconnectedPeerId);
      }
      // V9E Step 7: remove the disconnected peer from the BITCHAT relay
      // peer set so the RelayEngine stops selecting it as a forwarding target.
      const adapter = bitchatAdapterRef.current;
      if (adapter && disconnectedPeerId) {
        adapter.unregisterPeer(disconnectedPeerId);
      }
      // V9E Step 10: the peer set changed — refresh destination subscribers.
      notifyMeshDestinationsChanged();
      // V9E Step 9: a new connection to the same BLE device must re-announce
      // (connection-scoped ANNOUNCE, independent of voice mode).
      if (disconnectedPeerId) {
        announcedPeersRef.current.delete(disconnectedPeerId);
      }
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

    // V9E Step 9: the BITCHAT adapter is owned by the hook's MOUNT
    // lifecycle, not by voice mode. Initializing it here (once, on mount)
    // means mesh relay participation exists even when voice mode is off.
    getOrCreateAdapter().catch(() => {});

    // V9E Step 10: register the mesh-destination provider so other screens
    // (ConnectScreen) can offer destination selection without owning the
    // adapter. Unregistered on unmount.
    registerMeshDestinationsProvider(buildMeshDestinations);

    // V9E Step 9: ANNOUNCE is sent per BLE peer connection (connection-
    // scoped), not per voice-mode session, so a relay-only phone announces
    // itself and registers peers regardless of voice mode.
    const connectedSub = NativeBLE.onConnected((event: { deviceId: string }) => {
      const peerId = event?.deviceId;
      if (peerId) {
        sendAnnounceToPeer(peerId).catch(() => {});
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

    subsRef.current = [sttResultSub, bleDataSub, disconnSub, connectedSub, sendFailSub];

    return () => {
      subsRef.current.forEach((s) => s.remove());
      subsRef.current = [];
      // V9E Step 10: drop the mesh-destination provider with the hook.
      registerMeshDestinationsProvider(null);
      // Ensure mic is unmuted on cleanup.
      if (isMutedRef.current) {
        NativeSTT.unmuteMic();
        isMutedRef.current = false;
      }
    };
  }, [enabled, getOrCreatePeerReliability, getOrCreateAdapter, routeAckFromPeer, routeNackFromPeer, sendAckToPeer, sendInitialData, sendAnnounceToPeer, buildMeshDestinations]);

  // ── V7 reassembly cleanup timer (voice-mode-scoped) ───────────────
  //
  // V9E Step 9: this timer only cleans VOICE-scoped reassembly state. The
  // BITCHAT adapter (created on mount) and its relay state are NOT touched
  // here — voice-mode start/stop cannot tear down mesh lifecycle.
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
      // Turn off. Voice-only state is reset; BITCHAT mesh lifecycle is
      // NOT touched (V9E Step 9) — the adapter, peer registrations, and
      // relay state survive voice-mode stop.
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
    // V9E Step 10: logical voice destination (BITCHAT nodeId or broadcast).
    voiceDestinationNodeId,
    setVoiceDestinationNodeId: setVoiceDestination,
    /**
     * Nodes known to the mesh (direct peers + V9D-discovered nodes) for
     * destination selection. Returns BITCHAT nodeIds; direct peers are
     * marked with their BLE deviceId when mapped.
     */
    getMeshDestinations: buildMeshDestinations,
    toggleVoiceMode,
    clearError,
  };
}
