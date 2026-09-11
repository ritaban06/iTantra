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
  V6B_FRAME_TX_CONTROL,
  TX_OP_REQUEST,
  TX_OP_GRANT,
  TX_OP_RELEASE,
  TX_OWNER_NONE,
  TX_OWNER_SELF,
  TX_OWNER_REMOTE,
  buildTxControlFrame,
  decodeTxControlPayload,
  isGrantAccepted,
  V6B_VERSION,
  V6B_MAX_PAYLOAD_SIZE,
  splitV6A,
  splitV6AForBudget,
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
  HEADER_SIZE as BITCHAT_HEADER_SIZE,
  PROTOCOL_VERSION as BITCHAT_PROTOCOL_VERSION,
} from '../BITCHAT';
import {
  beginVoiceMvpTrace,
  clearVoiceMvpTrace,
  takeVoiceMvpTrace,
} from '../diagnostics/VoiceMvpTrace';
import {
  receiveChatApplicationPayload,
  registerChatTransport,
} from '../messages';

const { NativeSTT: NativeSTTModule } = NativeModules;
const { NativeTTS } = NativeModules;

export type BLEVoiceModeStatus =
  | 'OFF'
  | 'CONNECTING_MESH_ROUTE'
  | 'WAITING_FOR_SPEECH'
  | 'SENDING'
  | 'SENT'
  | 'RECEIVING'
  | 'SPEAKING'
  | 'ERROR';

/**
 * Per-connection half-duplex transmission ownership (direct A↔B link).
 *
 * TX_OWNER_NONE   — nobody owns the link; either side may request TX.
 * TX_OWNER_SELF   — local side owns the link; remote is gated (WAITING).
 * TX_OWNER_REMOTE — remote side owns the link; local PTT/STT is BLOCKED.
 */
export type TxOwnership =
  | typeof TX_OWNER_NONE
  | typeof TX_OWNER_SELF
  | typeof TX_OWNER_REMOTE;

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
  // Mirror of `enabled` for callbacks that must read the freshest value
  // without being re-created on every voice-mode toggle (e.g. TX watchdog).
  const enabledRef = useRef(enabled);
  const statusRef = useRef(status);

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
  // Bounded ANNOUNCE retry: one-shot sends are fragile (a NOTIFY_FAILED on
  // the server role before the client's CCCD is ready loses the ANNOUNCE
  // permanently). A small number of spaced retries makes registration heal
  // without flooding. Timers are tracked per peer and cleared on unmount.
  const ANNOUNCE_RETRY_DELAYS_MS = [500, 1500, 4000];
  const announceRetryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Live set of BLE peers with an active link (from CONNECTED/DISCONNECTED
  // events). Used as the ANNOUNCE retry liveness signal: retries must
  // continue while the underlying BLE connection exists even when the
  // BITCHAT mapping has not formed yet (e.g. server role whose peer's
  // ANNOUNCE was lost before our CCCD was ready).
  const connectedPeersRef = useRef<Set<string>>(new Set());
  // Readiness cache only; the adapter remains authoritative for the
  // NodeId↔BLE mapping and PeerRegistry state.
  const routeReadyPeersRef = useRef<Set<string>>(new Set());
  const markRouteReadyRef = useRef<(peerId: string) => void>(() => {});
  const getConnectedVoicePeerRef = useRef<() => Promise<string | null>>(async () => null);

  // ── Half-duplex transmission ownership (direct-link control plane) ──
  //
  // ONE side of a direct A↔B link may transmit voice at a time. Ownership
  // is session state of the CONNECTION — not a UI toggle. It is arbitrated
  // by the V6B_FRAME_TX_CONTROL control frame (REQUEST/GRANT/RELEASE) and
  // released on send failure, disconnect, or turn completion.
  const txOwnerRef = useRef<TxOwnership>(TX_OWNER_NONE);
  const [txOwnership, setTxOwnership] = useState<TxOwnership>(TX_OWNER_NONE);
  // Human-readable reason when the local side is WAITING (remote owns TX).
  const [txWaitReason, setTxWaitReason] = useState<string | null>(null);
  // Monotonic token for the CURRENT turn we own (0 while not owning).
  const txIdRef = useRef(0);
  // Monotonic counter shared by our outgoing REQUEST ids and grants we issue
  // (all tokens on a link come from both peers' counters — uniqueness per
  // turn is all that is required, and both sides never need to agree on the
  // counter itself, only on who currently holds a non-zero token).
  const txRequestCounterRef = useRef(0);
  // Pending REQUEST resolvers per peer — resolved by the matching GRANT
  // (or by timeout) in requestTxOwnership below.
  const txRequestResolversRef = useRef<Map<string, (v: number | null) => void>>(new Map());
  // Distinguishes a busy remote from a request that never reached a live
  // native connection. Both return null to the caller, but only the former
  // is a legitimate RECEIVING/WAITING state.
  type TxRequestOutcome = 'NONE' | 'BUSY' | 'UNREACHABLE' | 'TIMEOUT';
  const txRequestOutcomeRef = useRef<Map<string, TxRequestOutcome>>(new Map());
  // BLE peer that currently owns the link (either role) — used for the
  // remote-turn watchdog and for targeted RELEASE dispatch.
  const txOwningPeerRef = useRef<string | null>(null);
  // Mirror of `status` for callbacks that must read it without re-creating
  // (e.g. TX_RELEASE handler must not clobber an active local SPEAKING).
  // Deadline after which a remote-owned turn self-releases if the peer
  // stays silent (release frame lost / peer crashed mid-turn). Refreshed
  // on every voice frame received from the owning peer.
  const TX_REMOTE_WATCHDOG_MS = 12_000;
  const txRemoteWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTxRemoteWatchdog = useCallback(() => {
    if (txRemoteWatchdogRef.current) {
      clearTimeout(txRemoteWatchdogRef.current);
      txRemoteWatchdogRef.current = null;
    }
  }, []);
  const setTxOwner = useCallback((owner: TxOwnership) => {
    txOwnerRef.current = owner;
    setTxOwnership(owner);
    if (owner === TX_OWNER_REMOTE) {
      setTxWaitReason('Other device is transmitting…');
      // Safety: if the owner never RELEASEs (frame lost, crash), free the
      // link so the conversation cannot deadlock.
      clearTxRemoteWatchdog();
      txRemoteWatchdogRef.current = setTimeout(() => {
        txRemoteWatchdogRef.current = null;
        if (txOwnerRef.current === TX_OWNER_REMOTE) {
          console.warn('[BLE Voice] Remote TX watchdog fired — releasing stale ownership');
          setTxOwner(TX_OWNER_NONE);
          if (enabledRef.current) {
            setStatus('WAITING_FOR_SPEECH');
          }
        }
      }, TX_REMOTE_WATCHDOG_MS);
    } else {
      setTxWaitReason(null);
      clearTxRemoteWatchdog();
    }
  }, [clearTxRemoteWatchdog]);

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
    console.log(
      `[ITANTRA_MVP] V6B_ENCODE target=${deviceId} frameBytes=${frame.length}`,
    );
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
   * Ref to the current TX-control handler so the receive paths (defined
   * earlier in the hook body) always dispatch through the latest closure.
   */
  const handleTxControlRef = useRef<
    (peerId: string, payload: Uint8Array) => void
  >(() => {});
  /**
   * Ref to the current releaseTxOwnership so early-defined handlers (STT
   * result, watchdogs) can release a turn through the freshest closure.
   */
  const releaseTxOwnershipRef = useRef<(peerId?: string) => void>(() => {});

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
  const processV6BPayload = useCallback((
    v6bPayload: Uint8Array,
    fromPeerId: string,
    diagnosticId?: string,
  ) => {
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

      // Half-duplex control plane: ownership frames are control traffic —
      // handled and swallowed before any voice-content decoding.
      if (frame.frameType === V6B_FRAME_TX_CONTROL) {
        handleTxControlRef.current(fromPeerId, frame.payload);
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
              console.log(
                `[ITANTRA_MVP] msgId=${diagnosticId ?? 'unknown'} STEP=V7_REASSEMBLY ` +
                  `source=${fromPeerId} groupId=${header.groupId} fragmentIndex=${header.fragmentIndex} ` +
                  `fragmentCount=${header.totalFragments} status=${result.status}`,
              );
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
    } else if (v6bPayload.length > 0 && v6bPayload[0] === V7_MARKER) {
      // V7 fragment delivered through the BITCHAT mesh path (adapter
      // onLocalDeliver passes the raw fragment payload — mesh packets are
      // not V6B-wrapped at this layer). Reassemble exactly like the direct
      // V6B path: same Reassembler, keyed per BLE peer.
      try {
        const header = parseHeader(v6bPayload);
        const v6aChunk = v6bPayload.slice(V7_HEADER_SIZE);
        const result = reassemblerRef.current.addFragment(fromPeerId, header, v6aChunk);
        console.log(
          `[ITANTRA_MVP] msgId=${diagnosticId ?? 'unknown'} STEP=V7_REASSEMBLY ` +
            `source=${fromPeerId} groupId=${header.groupId} fragmentIndex=${header.fragmentIndex} ` +
            `fragmentCount=${header.totalFragments} status=${result.status}`,
        );
        if (result.status === 'complete') {
          semanticMsg = decodeWithFallback(result.v6aPacket);
          if (semanticMsg) {
            const msgId = semanticMsg.messageId;
            if (deliveredCacheRef.current.isDelivered(fromPeerId, msgId)) {
              // Duplicate mesh delivery — block TTS (mesh has no per-hop ACK loop).
              semanticMsg = null;
            } else {
              deliveredCacheRef.current.markDelivered(fromPeerId, msgId);
              completedGroupCacheRef.current.store(fromPeerId, header.groupId, msgId);
            }
          }
        } else if (result.status === 'error') {
          console.warn(`[BLE Voice] Mesh V7 reassembly error: ${result.reason}`);
        }
        // else: incomplete — wait for more mesh fragments
      } catch (e: any) {
        console.warn(`[BLE Voice] Mesh V7 fragment parse error: ${e.message}`);
      }
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
      console.log(
        `[ITANTRA_MVP] msgId=${diagnosticId ?? semanticMsg.messageId} STEP=SEMANTIC_DECODE ` +
          `semanticMessageId=${semanticMsg.messageId} textLength=${text.length} language=${semanticMsg.language}`,
      );
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
    console.log(
        `[ITANTRA_MVP] msgId=${diagnosticId ?? semanticMsg?.messageId ?? 'unknown'} STEP=TTS_START ` +
        `text=${JSON.stringify(text)} language=${ttsLanguage}`,
    );
    NativeTTS.speak(text, ttsLanguage, false)
      .then(() => {
        console.log(`[ITANTRA_MVP] msgId=${diagnosticId ?? semanticMsg?.messageId ?? 'unknown'} STEP=TTS_RESULT result=SUCCESS`);
        if (isMutedRef.current) { NativeSTT.unmuteMic(); isMutedRef.current = false; }
        setStatus(enabled ? 'WAITING_FOR_SPEECH' : 'OFF');
        setReceivedMessages((prev) => prev.map((m) => m.time === message.time ? { ...m, status: 'spoken' as const } : m));
      })
      .catch((err: any) => {
        console.warn(
          `[ITANTRA_MVP] msgId=${diagnosticId ?? semanticMsg?.messageId ?? 'unknown'} STEP=TTS_ERROR ` +
            `error=${String(err?.message || err)}`,
        );
        if (isMutedRef.current) { NativeSTT.unmuteMic(); isMutedRef.current = false; }
        setVoiceError(`TTS error: ${err.message || err}`);
        setStatus('ERROR');
      });
  }, [enabled, routeAckFromPeer, routeNackFromPeer, sendAckToPeer]);

  /**
   * Initialize or get the BITCHAT adapter.
   *
   * The adapter's onAnnounceReceived callback dispatches through
   * scheduleAnnounceRef so the (later-defined) bounded-retry sender is
   * always reached with the freshest closure, independent of definition order.
   */
  const scheduleAnnounceRef = useRef<(peerId: string, force?: boolean) => void>(() => {});
  const getOrCreateAdapter = useCallback(async (): Promise<BitChatBLEAdapter> => {
    const bindChatApplication = (adapter: BitChatBLEAdapter): void => {
      registerChatTransport({
        localNodeId: adapter.getLocalNodeId(),
        originate: (payload, packetId, destinationNodeId, fragmentCount) =>
          adapter.originate(payload, packetId, destinationNodeId, undefined, fragmentCount),
        canRouteTo: (destinationNodeId) => {
          const directBlePeer = adapter.getBlePeerForNodeId(destinationNodeId);
          if (directBlePeer) return adapter.isDirectPeerReady(directBlePeer);
          const discovered = adapter.getDiscoveredNodes().some(node => node.nodeId === destinationNodeId);
          return discovered && adapter.getConnectedPeers().length > 0;
        },
      });
    };

    if (bitchatAdapterRef.current) {
      bindChatApplication(bitchatAdapterRef.current);
      return bitchatAdapterRef.current;
    }

    // Get or create NodeIdStore
    if (!nodeIdStoreRef.current) {
      nodeIdStoreRef.current = new NodeIdStore(storageBackend);
    }
    const localNodeId = await nodeIdStoreRef.current.getLocalNodeId();

    // Create adapter
    const adapter = new BitChatBLEAdapter({
      localNodeId,
      bleSend: async (peerBleId: string, payload: Uint8Array, diagnosticId?: string) => {
        // V9C: Wrap BITCHAT envelope in V6B for per-hop transport framing.
        // V9E Step 6: each BLE peer has its own SequenceManager, and the
        // frame is sent with peer targeting (never the legacy no-peer path).
        const { seqManager } = getOrCreatePeerReliability(peerBleId);
        const seq = seqManager.nextSequence();
        const v6bFrame = v6bEncode(seq, V6B_FRAME_BITCHAT, payload);
        const routeReady =
          connectedPeersRef.current.has(peerBleId) &&
          bitchatAdapterRef.current?.isDirectPeerReady(peerBleId) === true;
        console.log(
          `[ITANTRA_MVP] msgId=${diagnosticId ?? 'control'} STEP=TX_TARGET ` +
            `blePeerId=${peerBleId} routeReady=${routeReady}`,
        );
        console.log(
          `[ITANTRA_MVP] msgId=${diagnosticId ?? 'control'} STEP=V6B_ENCODE ` +
            `target=${peerBleId} frameBytes=${v6bFrame.length} frameType=${V6B_FRAME_BITCHAT}`,
        );
        await NativeBLE.send(bytesToBase64(v6bFrame), peerBleId, diagnosticId);
      },
      onLocalDeliver: (
        v6bPayload: Uint8Array,
        fromPeerId?: string,
        diagnosticId?: string,
        sourceNodeId?: string,
        destinationNodeId?: string,
      ) => {
        // Typed chat is an application payload inside the existing BITCHAT
        // DATA frame. It never enters the voice decoder/TTS path. Every
        // other payload keeps the established voice behavior unchanged.
        if (receiveChatApplicationPayload(v6bPayload, {
          fromPeerId,
          sourceNodeId,
          destinationNodeId,
        })) {
          return;
        }
        // Pass existing voice payloads to the established decode pipeline.
        processV6BPayload(v6bPayload, fromPeerId ?? 'unknown', diagnosticId);
      },
      onAnnounceReceived: (blePeerId: string) => {
        markRouteReadyRef.current(blePeerId);
        // V9E-announce-heal: a valid incoming ANNOUNCE proves the direct link
        // is fully established (the peer could receive our frames), so answer
        // with our own ANNOUNCE if the peer has not registered us yet. This
        // makes registration symmetric even when the peer's connection-time
        // ANNOUNCE was sent too early (server role, before our CCCD write).
        scheduleAnnounceRef.current(blePeerId, true);
      },
    });
    bitchatAdapterRef.current = adapter;
    bindChatApplication(adapter);
    return adapter;
  }, [storageBackend, getOrCreatePeerReliability, processV6BPayload]);

  /** Clear any pending ANNOUNCE retry timers for a peer. */
  const clearAnnounceRetry = useCallback((peerId: string): void => {
    const timer = announceRetryTimersRef.current.get(peerId);
    if (timer) {
      clearTimeout(timer);
      announceRetryTimersRef.current.delete(peerId);
    }
  }, []);

  const resetAnnounceState = useCallback((peerId: string): void => {
    announcedPeersRef.current.delete(peerId);
    routeReadyPeersRef.current.delete(peerId);
    clearAnnounceRetry(peerId);
  }, [clearAnnounceRetry]);

  /** Check the exact native key plus the adapter's current direct route. */
  const isDirectRouteReady = useCallback((peerId: string): boolean => {
    if (!connectedPeersRef.current.has(peerId)) return false;
    return bitchatAdapterRef.current?.isDirectPeerReady(peerId) === true;
  }, []);

  const markDirectRouteReady = useCallback((peerId: string): void => {
    if (!isDirectRouteReady(peerId)) return;
    const wasReady = routeReadyPeersRef.current.has(peerId);
    routeReadyPeersRef.current.add(peerId);
    if (!wasReady && enabledRef.current && statusRef.current === 'CONNECTING_MESH_ROUTE') {
      setVoiceError(null);
      setStatus('WAITING_FOR_SPEECH');
    }
  }, [isDirectRouteReady]);
  markRouteReadyRef.current = markDirectRouteReady;

  // ── Half-duplex TX ownership control plane ─────────────────────

  /** Send a raw TX control op to a specific peer (per-peer sequence stream). */
  const sendTxControl = useCallback(
    async (peerId: string, op: number, txId: number, requestId: number): Promise<void> => {
      const { seqManager } = getOrCreatePeerReliability(peerId);
      const frame = buildTxControlFrame(seqManager.nextSequence(), { op, txId, requestId });
      await NativeBLE.send(bytesToBase64(frame), peerId);
    },
    [getOrCreatePeerReliability],
  );

  /**
   * Request TX ownership on the link to `peerId`.
   *
   * Returns the granted txId (non-zero) on success, or null when the remote
   * side is busy / unreachable / did not answer in time. The caller MUST
   * NOT start STT until this resolves with a grant. Local guards make the
   * call idempotent while we own the link and honest while the remote owns
   * it. Only ONE in-flight request per peer is allowed.
   */
  const requestTxOwnership = useCallback(
    async (peerId: string): Promise<number | null> => {
      // Every request starts clean. Outcomes are keyed by native BLE peer so
      // a prior BUSY/TIMEOUT result cannot leak into a later request.
      txRequestOutcomeRef.current.set(peerId, 'NONE');
      // Link liveness is checked against the SAME native key that will be
      // passed to send(). The legacy no-argument query can report a different
      // primary peer when multiple connections or a reconnect are present.
      if (typeof (NativeBLE as any).getConnectedDeviceIds === 'function') {
        try {
          const info = await NativeBLE.getConnectionState(peerId);
          console.log(
            `[ITANTRA_TX] stage=getConnectionState target=${peerId} ` +
              `connectedPeersRef=[${[...connectedPeersRef.current].join(',')}] ` +
              `state=${info?.state ?? 'MISSING'} deviceId=${info?.deviceId ?? ''} ` +
              `txOwner=${txOwnerRef.current}`,
          );
          if (!(info?.state === 'CONNECTED' && info.deviceId === peerId)) {
            connectedPeersRef.current.delete(peerId);
            txRequestOutcomeRef.current.set(peerId, 'UNREACHABLE');
            return null;
          }
        } catch {
          console.warn(
            `[ITANTRA_TX] stage=getConnectionState target=${peerId} ` +
              `connectedPeersRef=[${[...connectedPeersRef.current].join(',')}] result=ERROR`,
          );
          txRequestOutcomeRef.current.set(peerId, 'UNREACHABLE');
          return null;
        }
      }
      // Local-side guard: we already own it (idempotent) or remote owns it.
      if (txOwnerRef.current === TX_OWNER_SELF) return txIdRef.current || null;
      if (txOwnerRef.current === TX_OWNER_REMOTE) return null;
      // One in-flight request per peer.
      if (txRequestResolversRef.current.has(peerId)) return null;

      const requestId = ++txRequestCounterRef.current >>> 0;
      // Pre-register the resolver BEFORE the REQUEST hits the wire so a
      // fast GRANT can never slip past unobserved (ownership/return-value
      // desync race).
      let resolveFn!: (v: number | null) => void;
      const promise = new Promise<number | null>((resolve) => {
        resolveFn = resolve;
      });
      txRequestResolversRef.current.set(peerId, resolveFn);
      try {
        await sendTxControl(peerId, TX_OP_REQUEST, 0, requestId);
      } catch (error) {
        txRequestResolversRef.current.delete(peerId);
        txRequestOutcomeRef.current.set(peerId, 'UNREACHABLE');
        console.warn(
          `[ITANTRA_TX] stage=sendTxControl target=${peerId} ` +
            `connectedPeersRef=[${[...connectedPeersRef.current].join(',')}] ` +
            `result=ERROR error=${String(error)}`,
        );
        return null;
      }
      // Bounded wait: an unanswered/lost REQUEST must not block PTT forever.
      const timer = setTimeout(() => {
        if (txRequestResolversRef.current.get(peerId) === resolveFn) {
          txRequestResolversRef.current.delete(peerId);
          txRequestOutcomeRef.current.set(peerId, 'TIMEOUT');
          resolveFn(null);
        }
      }, 1500);
      void timer;
      return promise;
    },
    [sendTxControl],
  );

  /**
   * Release OUR ownership of the link (turn complete / failed / cancelled).
   * Notifies the remote side so it can become READY. Idempotent.
   */
  const releaseTxOwnership = useCallback(
    async (peerId?: string): Promise<void> => {
      const wasOwner = txOwnerRef.current === TX_OWNER_SELF;
      const ownedTxId = txIdRef.current;
      // Always clear local state first — no lock leak even if the notify
      // send fails (remote side self-heals on its own failure paths).
      txIdRef.current = 0;
      setTxOwner(TX_OWNER_NONE);
      if (wasOwner) {
        const target = peerId ?? [...connectedPeersRef.current][0];
        if (target && connectedPeersRef.current.has(target)) {
          try {
            await sendTxControl(target, TX_OP_RELEASE, ownedTxId, 0);
          } catch {
            /* remote self-heals via its own failure/timeout paths */
          }
        }
      }
    },
    [sendTxControl],
  );

  /**
   * Handle an incoming TX_CONTROL frame from a peer.
   *
   * Deterministic arbitration: only the side whose GRANT carries a non-zero
   * txId owns the turn. A REQUEST received while WE own the link is denied
   * with GRANT(txId=0) — the requester shows WAITING and never starts STT.
   */
  const handleTxControl = useCallback(
    async (peerId: string, payload: Uint8Array): Promise<void> => {
      const ctrl = decodeTxControlPayload(payload);
      if (!ctrl) {
        console.warn(`[BLE Voice] Malformed TX_CONTROL dropped from ${peerId}`);
        return;
      }

      if (ctrl.op === TX_OP_REQUEST) {
        if (txOwnerRef.current === TX_OWNER_NONE) {
          // Grant: the remote now owns this turn under a non-zero token.
          const grantedTxId = (++txRequestCounterRef.current & 0xffffffff) || 1;
          txIdRef.current = 0; // WE do not own the token; remote does.
          txOwningPeerRef.current = peerId;
          setTxOwner(TX_OWNER_REMOTE);
          try {
            await sendTxControl(peerId, TX_OP_GRANT, grantedTxId, ctrl.requestId);
          } catch {
            // Grant could not be delivered — revert; the remote's bounded
            // request timeout lets its user retry.
            txOwningPeerRef.current = null;
            setTxOwner(TX_OWNER_NONE);
            return;
          }
          // Remote is transmitting now: mirror the receiver UX so the
          // local user sees WAIT/RECEIVING and PTT is gated.
          if (enabledRef.current) {
            setStatus('RECEIVING');
          }
        } else {
          // Busy: deny implicitly with a zero-token grant. The requester          // resolves null and shows WAITING — never starts STT.
          try {
            await sendTxControl(peerId, TX_OP_GRANT, 0, ctrl.requestId);
          } catch {
            /* ignore */
          }
        }
        return;
      }

      if (ctrl.op === TX_OP_GRANT) {
        // Only a request WE sent can be granted. An unsolicited GRANT (no
        // pending resolver) is ignored — it cannot grant what we never
        // asked for, and honoring it would corrupt ownership state.
        const resolver = txRequestResolversRef.current.get(peerId);
        if (!resolver) {
          console.warn(`[BLE Voice] Unsolicited TX GRANT ignored from ${peerId}`);
          return;
        }
        // Consume the request slot NOW — a granted/answered request must
        // free the peer's slot or the next PTT could never request again.
        txRequestResolversRef.current.delete(peerId);
        const accepted = isGrantAccepted(ctrl);
        txRequestOutcomeRef.current.set(peerId, accepted ? 'NONE' : 'BUSY');
        resolver(accepted ? ctrl.txId : null);
        if (isGrantAccepted(ctrl)) {
          txIdRef.current = ctrl.txId;
          txOwningPeerRef.current = peerId;
          setTxOwner(TX_OWNER_SELF);
        }
        return;
      }

      if (ctrl.op === TX_OP_RELEASE) {
        // Remote finished (or aborted) its turn → link is free again.
        if (txOwnerRef.current === TX_OWNER_REMOTE) {
          txOwningPeerRef.current = null;
          setTxOwner(TX_OWNER_NONE);
          if (enabledRef.current && statusRef.current !== 'SPEAKING') {
            setStatus('WAITING_FOR_SPEECH');
          }
        }
      }
    },
    [sendTxControl],
  );

  // Keep the refs current so the receive paths always use the freshest
  // handler closure (the handler itself depends only on stable callbacks).
  handleTxControlRef.current = (peerId: string, payload: Uint8Array) => {
    handleTxControl(peerId, payload).catch(() => {});
  };
  releaseTxOwnershipRef.current = (peerId?: string) => {
    releaseTxOwnership(peerId).catch(() => {});
  };

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

  /**
   * Send our direct-link ANNOUNCE to a BLE peer with bounded retries.
   *
   * The first send happens immediately; if the peer has not registered us
   * (i.e. it never answered with its own ANNOUNCE), we retry a small number
   * of times with increasing spacing. Each retry is harmless (duplicate
   * ANNOUNCE is idempotent) and gives both sides multiple chances to learn
   * each other's identity on a lossy/too-early first exchange.
   */
  const scheduleAnnounceToPeer = useCallback((peerId: string, force = false): void => {
    if (announcedPeersRef.current.has(peerId)) return;
    if (announceRetryTimersRef.current.has(peerId)) {
      // An incoming ANNOUNCE is a handshake-healing signal: replace the
      // existing retry schedule with an immediate response. Ordinary
      // connection/reconciliation calls remain idempotent.
      if (!force) return;
      clearAnnounceRetry(peerId);
    }
    sendAnnounceToPeer(peerId).catch(() => {});

    // Bounded retry loop — cancelled by clearAnnounceRetry on success/disconnect.
    const attemptRetry = (delayIndex: number): void => {
      const timer = setTimeout(() => {
        announceRetryTimersRef.current.delete(peerId);
        if (announcedPeersRef.current.has(peerId)) return;
        const adapter = bitchatAdapterRef.current;
        // Link down? Stop retrying (reconnect re-schedules a fresh loop).
        // NOTE: liveness is the BLE connection, NOT the BITCHAT mapping —
        // a server-role side may have zero mapping while the link is healthy
        // and must keep retrying so the peer can learn us.
        if (!adapter || !connectedPeersRef.current.has(peerId)) {
          return;
        }
        sendAnnounceToPeer(peerId).catch(() => {});
        if (delayIndex + 1 < ANNOUNCE_RETRY_DELAYS_MS.length) {
          attemptRetry(delayIndex + 1);
        }
      }, ANNOUNCE_RETRY_DELAYS_MS[delayIndex]);
      announceRetryTimersRef.current.set(peerId, timer);
    };

    if (ANNOUNCE_RETRY_DELAYS_MS.length > 0) {
      attemptRetry(0);
    }
  }, [sendAnnounceToPeer, clearAnnounceRetry]);

  // Keep the announce-dispatch ref current so the adapter's
  // onAnnounceReceived always uses the latest sender.
  scheduleAnnounceRef.current = scheduleAnnounceToPeer;

  /**
   * Reconcile connections that were established before this hook mounted.
   * Discovery owns the native connection lifecycle, so relying only on a
   * future BLE_CONNECTED event loses the first-send path when the user
   * navigates from Devices to Home after connecting.
   */
  const reconcileConnectedPeers = useCallback(async (): Promise<void> => {
    try {
      const getConnectedDeviceIds = (NativeBLE as any).getConnectedDeviceIds;
      let ids: unknown = [];
      const hasNativePeerList = typeof getConnectedDeviceIds === 'function';
      if (typeof getConnectedDeviceIds === 'function') {
        ids = await getConnectedDeviceIds();
      }
      const liveIds = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
      const live = new Set(liveIds);
      connectedPeersRef.current.forEach((id) => {
        if (!live.has(id)) connectedPeersRef.current.delete(id);
      });
      liveIds.forEach((peerId) => {
        connectedPeersRef.current.add(peerId);
      });
      console.log(
        `[ITANTRA_TX] stage=reconcile nativeConnectedDeviceIds=[${liveIds.join(',')}] ` +
          `connectedPeersRef=[${[...connectedPeersRef.current].join(',')}]`,
      );
      // Adapter creation may wait on persisted identity storage. Native
      // connection reconciliation must not block PTT on that unrelated
      // initialization; announce as soon as the adapter is ready.
      getOrCreateAdapter()
        .then((adapter) => {
          if (hasNativePeerList) {
            adapter.getDirectBlePeerIds()
              .filter((peerId) => !live.has(peerId))
              .forEach((peerId) => {
                resetAnnounceState(peerId);
                adapter.unregisterPeer(peerId);
              });
          }
          liveIds.forEach((peerId) => {
            if (!isDirectRouteReady(peerId)) scheduleAnnounceToPeer(peerId);
            else markDirectRouteReady(peerId);
          });
          if (liveIds.length > 0) {
            console.log(`[BLE Voice][CONNECTION] reconciled peers=${liveIds.join(',')} adapter=${adapter.getLocalNodeId()}`);
          }
        })
        .catch((err) => {
          console.warn(`[BLE Voice][CONNECTION] adapter reconciliation failed: ${String(err)}`);
        });
    } catch (err) {
      console.warn(`[BLE Voice][CONNECTION] peer reconciliation failed: ${String(err)}`);
    }
  }, [getOrCreateAdapter, isDirectRouteReady, markDirectRouteReady, resetAnnounceState, scheduleAnnounceToPeer]);

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
  enabledRef.current = enabled;
  statusRef.current = status;

  // ── Subscribe to STT and BLE events ────────────────────────────────

  useEffect(() => {
    const sttEmitter = new NativeEventEmitter(NativeSTTModule);

    // When a final STT result arrives and voice mode is on, send via BLE.
    const sttResultSub = sttEmitter.addListener('STT_RESULT', async (event: any) => {
      if (!enabled) return;

      const transcript = event.transcript?.trim();
      if (!transcript) {
        clearVoiceMvpTrace();
        // Empty result = turn produced no speech. Release the half-duplex
        // lock so the peer is never stuck WAITING on an aborted turn.
        if (txOwnerRef.current === TX_OWNER_SELF) {
          releaseTxOwnershipRef.current(txOwningPeerRef.current ?? undefined);
        }
        return;
      }
      const trace = takeVoiceMvpTrace();
      console.log(
        `[ITANTRA_MVP] msgId=${trace?.packetId ?? 'unassigned'} STEP=STT_FINAL ` +
          `textLength=${transcript.length}`,
      );

      // ── Half-duplex gate: STT produced text, but we may not own the link. ──
      // Ownership is normally acquired at PTT press (beginPttTurn) so the
      // remote side shows WAITING while the user is still speaking. This
      // result-time guard is the honest fallback: if the remote side owns
      // TX (e.g. it acquired while we were speaking), the turn is refused —
      // no packet is created, nothing is enqueued, no false SEND.
      if (txOwnerRef.current === TX_OWNER_REMOTE) {
        console.warn('[BLE Voice] STT result dropped — remote device is transmitting');
        setVoiceError('Other device is transmitting — please wait');
        setStatus('RECEIVING');
        return;
      }

      // Create a SemanticMessage from the STT transcript.
      const semanticMsg = createSemanticMessage(transcript, {
        language: languageCodeRef.current,
      });
      // Keep the diagnostic's PTT/STT correlation ID identical to the V6A
      // compact ID and BITCHAT packet ID without placing any extra bytes on
      // the BLE wire.
      if (trace) {
        semanticMsg.messageId = trace.semanticMessageId;
      }

      const v6aEncoded = encodeUnrestricted(semanticMsg);
      const byteLen = binaryGetEncodedByteLength(semanticMsg);
      console.log(
        `[ITANTRA_MVP] msgId=${trace?.packetId ?? 'unassigned'} STEP=SEMANTIC_ENCODE ` +
          `bytes=${v6aEncoded.length} semanticMessageId=${semanticMsg.messageId}`,
      );

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
      console.log(
        `[ITANTRA_MVP] msgId=${normalizePacketId(compactHash)} STEP=V6A_ENCODE ` +
          `semanticMessageId=${semanticMsg.messageId} v6aBytes=${v6aEncoded.length}`,
      );

      const markSent = (): void => {
        setSendStatus('sent');
        setStatus('SENT');
        // Turn complete: release the half-duplex lock so the peer can talk.
        releaseTxOwnership(txOwningPeerRef.current ?? undefined).catch(() => {});
        setTimeout(() => {
          if (enabled) setStatus('WAITING_FOR_SPEECH');
        }, 1500);
      };
      /**
       * Honest-failure gate: 'SENT' must mean "the packet was actually handed
       * to at least one valid forwarding BLE peer". Zero forwarded peers is a
       * real send failure (e.g. empty BITCHAT registry, missing node mapping,
       * or a failed native write) — never a silent false success.
       */
      const markForwardedOrFailed = (forwardedCount: number): void => {
        if (forwardedCount > 0) {
          markSent();
        } else {
          markFailed(new Error('No connected mesh peer accepted the message (registry empty or transmission failed)'));
        }
      };
      const markFailed = (err: any): void => {
        setSendStatus('failed');
        setVoiceError(`Send failed: ${err.message || err}`);
        setStatus('ERROR');
        // A failed turn MUST release the lock — no permanent BUSY state.
        releaseTxOwnership(txOwningPeerRef.current ?? undefined).catch(() => {});
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
        const doSend = async (): Promise<number> => {
          // Mesh path frame budget: BITCHAT(28) + V6B(10) + fragment must fit
          // the 499-byte V6B payload, so mesh fragments carry ≤461 bytes of
          // V6A data. Short packets go as a single un-fragmented envelope.
          const meshChunkBudget = V6B_MAX_PAYLOAD_SIZE - BITCHAT_HEADER_SIZE; // 471 total incl. V7 header
          const meshFragments = splitV6AForBudget(v6aEncoded, meshChunkBudget);

          if (meshFragments.length === 0) {
            return await adapter!.originate(
              v6aEncoded,
              normalizePacketId(compactHash),
              destinationNodeId,
              undefined,
              1,
            );
          }

          // Long message: originate each V7 fragment as its own BITCHAT DATA
          // packet (same group header inside each payload). The receiving
          // side reassembles in processV6BPayload via the V7 branch.
          console.log(
            `[BLE Voice] Mesh path: fragmented into ${meshFragments.length} BITCHAT packets (V6A ${byteLen} bytes)`,
          );
          let totalForwarded = 0;
          for (const frag of meshFragments) {
            const fragPacketId = normalizePacketId(
              (compactHash + BigInt(frag.header.fragmentIndex)) & BigInt('0xffffffffffffffff'),
            );
            const forwarded = await adapter!.originate(
              frag.payload,
              fragPacketId,
              destinationNodeId,
              undefined,
              meshFragments.length,
            );
            if (forwarded === 0) {
              return 0;
            }
            totalForwarded += forwarded;
          }
          return totalForwarded;
        };
        doSend().then(markForwardedOrFailed).catch(markFailed);
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
        // The per-peer reliability queue now owns delivery; release the
        // half-duplex lock so the peer is never stuck WAITING on a turn
        // whose frames have not even been written yet.
        releaseTxOwnership(targetPeerId).catch(() => {});
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
      console.log(
        `[ITANTRA_MVP] BLE_RECEIVE from=${event.fromDevice} bytes=${decoded.length}`,
      );

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
          console.log(
            `[ITANTRA_MVP] STEP=V6B_DECODE type=${frame.frameType} sequence=${frame.sequence} ` +
              `source=${event.fromDevice} bytes=${rawData.length}`,
          );

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

          // Half-duplex control plane: ownership frames are control
          // traffic — handled and swallowed before voice-content decoding.
          if (frame.frameType === V6B_FRAME_TX_CONTROL) {
            handleTxControlRef.current(event.fromDevice, frame.payload);
            return; // control — stop processing
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
        console.log(
          `[ITANTRA_MVP] msgId=${semanticMsg.messageId} STEP=SEMANTIC_DECODE ` +
            `textLength=${text.length} language=${semanticMsg.language}`,
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
      console.log(
        `[ITANTRA_MVP] msgId=${semanticMsg?.messageId ?? 'unknown'} STEP=TTS_START ` +
          `text=${JSON.stringify(text)} language=${ttsLanguage}`,
      );
      NativeTTS.speak(text, ttsLanguage, false)
        .then(() => {
          console.log('[ITANTRA_MVP] STEP=TTS_RESULT result=SUCCESS');
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
          console.warn(`[ITANTRA_MVP] STEP=TTS_ERROR error=${String(err?.message || err)}`);
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
        connectedPeersRef.current.delete(disconnectedPeerId);
        resetAnnounceState(disconnectedPeerId);
      }
      // Half-duplex: a disconnect always releases link ownership — the lock
      // belongs to the CONNECTION, so it cannot survive a lost link. Both
      // roles (we owned it, or the remote owned it) reset to NO_OWNER.
      if (disconnectedPeerId && txOwningPeerRef.current === disconnectedPeerId) {
        txOwningPeerRef.current = null;
        txIdRef.current = 0;
        setTxOwner(TX_OWNER_NONE);
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
    reconcileConnectedPeers().catch(() => {});

    // V9E Step 10: register the mesh-destination provider so other screens
    // (ConnectScreen) can offer destination selection without owning the
    // adapter. Unregistered on unmount.
    registerMeshDestinationsProvider(buildMeshDestinations);

    // V9E Step 9: ANNOUNCE is sent per BLE peer connection (connection-
    // scoped), not per voice-mode session, so a relay-only phone announces
    // itself and registers peers regardless of voice mode. Bounded retries
    // make the exchange survive a lost/too-early first send.
    const connectedSub = NativeBLE.onConnected((event: { deviceId: string }) => {
      const peerId = event?.deviceId;
      if (peerId) {
        // Every native CONNECTED event starts a fresh connection-scoped
        // BITCHAT route. Do not reuse a mapping from an earlier reconnect.
        bitchatAdapterRef.current?.unregisterPeer(peerId);
        resetAnnounceState(peerId);
        connectedPeersRef.current.add(peerId);
        scheduleAnnounceToPeer(peerId);
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
      // Clear any pending ANNOUNCE retry timers on unmount.
      announceRetryTimersRef.current.forEach((timer) => clearTimeout(timer));
      announceRetryTimersRef.current.clear();
      // V9E Step 10: drop the mesh-destination provider with the hook.
      registerMeshDestinationsProvider(null);
      // The adapter belongs to this hook's lifecycle; do not leave a stale
      // application sender bound after its BLE listeners are removed.
      registerChatTransport(null);
      // Ensure mic is unmuted on cleanup.
      if (isMutedRef.current) {
        NativeSTT.unmuteMic();
        isMutedRef.current = false;
      }
    };
  }, [enabled, getOrCreatePeerReliability, getOrCreateAdapter, reconcileConnectedPeers, routeAckFromPeer, routeNackFromPeer, sendAckToPeer, sendInitialData, scheduleAnnounceToPeer, clearAnnounceRetry, resetAnnounceState, buildMeshDestinations]);

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

  /**
   * Half-duplex PTT gate — call BEFORE starting STT for an outgoing turn.
   *
   * Returns true when the local side may transmit (ownership acquired or
   * already held), false when the link is busy/unavailable. When false, the
   * caller MUST NOT start microphone capture / STT: recording a turn that
   * can never be sent wastes the user's speech and invites collisions.
   *
   * Deterministic arbitration: the first valid REQUEST wins; a busy remote
   * answers with a zero-token grant and the requester stays WAITING.
   */
  const beginPttTurn = useCallback(async (): Promise<boolean> => {
    if (!enabledRef.current) return true; // voice mode off — nothing to gate
    // Already owning the link: idempotent re-press.
    if (txOwnerRef.current === TX_OWNER_SELF) return true;
    // Remote owns the link: hard WAIT — no STT for an outgoing message.
    if (txOwnerRef.current === TX_OWNER_REMOTE) return false;
    // Refresh the native peer list so a connection made on the Discovery
    // screen before Home mounted is eligible for the first PTT turn.
    await reconcileConnectedPeers();
    // Pick the turn target: primary connected peer, else the native
    // connection view (legacy direct path without BITCHAT).
    const primaryPeer = [...connectedPeersRef.current][0];
    const target = primaryPeer ?? (await getConnectedVoicePeerRef.current());
    console.log(
      `[ITANTRA_TX] stage=beginPtt target=${target ?? ''} ` +
        `connectedPeersRef=[${[...connectedPeersRef.current].join(',')}] ` +
        `txOwner=${txOwnerRef.current}`,
    );
    console.log(
      `[ITANTRA_MVP] TX_REQUEST target=${target ?? ''} txOwner=${txOwnerRef.current} ` +
        `routeReady=${target ? isDirectRouteReady(target) : false}`,
    );
    if (!target) {
      setVoiceError('Connect to a device first');
      return false;
    }
    // With the current peer-aware native module, BLE CONNECTED is not enough
    // to start a voice turn. The exact key must already have an ANNOUNCE-
    // derived direct BITCHAT route.
    if (typeof (NativeBLE as any).getConnectedDeviceIds === 'function' && !isDirectRouteReady(target)) {
      setVoiceError(null);
      setStatus('CONNECTING_MESH_ROUTE');
      return false;
    }
    const grantedTxId = await requestTxOwnership(target);
    if (!grantedTxId) {
      // Only an explicit zero-token grant means the remote owns the turn.
      // A transport failure/timeout is an error, never RECEIVING; otherwise
      // both phones can falsely render "Receiving..." when neither can send.
      const outcome = txRequestOutcomeRef.current.get(target) ?? 'NONE';
      if (outcome === 'BUSY') {
        setStatus('RECEIVING');
      } else {
        const reason = outcome === 'TIMEOUT'
          ? 'TX ownership request timed out'
          : 'TX ownership request failed: native peer is not connected';
        setVoiceError(reason);
        setStatus('ERROR');
      }
      return false;
    }
    txOwningPeerRef.current = target;
    const trace = beginVoiceMvpTrace();
    console.log(
      `[ITANTRA_MVP] msgId=${trace.packetId} STEP=PTT_ARMED ` +
        `target=${target} semanticMessageId=${trace.semanticMessageId}`,
    );
    return true;
  }, [isDirectRouteReady, reconcileConnectedPeers, requestTxOwnership]);

  /**
   * End the local PTT turn: release ownership so the peer can talk.
   * Called on PTT release if no message was produced (empty speech), so a
   * held lock never blocks the conversation.
   */
  const endPttTurn = useCallback((): void => {
    if (txOwnerRef.current === TX_OWNER_SELF) {
      releaseTxOwnership(txOwningPeerRef.current ?? undefined).catch(() => {});
    }
  }, [releaseTxOwnership]);

  /**
   * Select the first currently connected native BLE key in native order.
   *
   * The peer list is authoritative for Link enablement. The legacy
   * no-argument state query is retained only for older native modules that do
   * not expose getConnectedDeviceIds yet.
   */
  const getConnectedVoicePeer = useCallback(async (): Promise<string | null> => {
    const getConnectedDeviceIds = (NativeBLE as any).getConnectedDeviceIds;
    if (typeof getConnectedDeviceIds === 'function') {
      try {
        const ids = await getConnectedDeviceIds();
        if (!Array.isArray(ids)) return null;

        for (const deviceId of ids) {
          if (typeof deviceId !== 'string' || deviceId.length === 0) continue;
          try {
            const info = await NativeBLE.getConnectionState(deviceId);
            if (info?.state === 'CONNECTED' && info.deviceId === deviceId) {
              return deviceId;
            }
          } catch {
            // A stale/unqueryable key is not a valid Link target.
          }
        }
        return null;
      } catch {
        // Compatibility fallback for a native module predating the peer-list
        // method. A successful peer-list response (including []) never falls
        // through to this legacy query.
      }
    }

    try {
      const info = await NativeBLE.getConnectionState();
      return info?.state === 'CONNECTED' && info.deviceId ? info.deviceId : null;
    } catch {
      return null;
    }
  }, []);
  getConnectedVoicePeerRef.current = getConnectedVoicePeer;

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
        const connectedPeerId = await getConnectedVoicePeer();
        if (!connectedPeerId) {
          setVoiceError('Connect to a device first');
          return;
        }
        // Reuse the exact native key verified above for the first PTT turn;
        // reconciliation will refresh this set from the same native source.
        connectedPeersRef.current.add(connectedPeerId);
        const routeReady = isDirectRouteReady(connectedPeerId);
        setEnabled(true);
        setStatus(routeReady ? 'WAITING_FOR_SPEECH' : 'CONNECTING_MESH_ROUTE');
        setVoiceError(null);
        setLastSentMessage(null);
        setSendStatus('idle');
      } catch (e: any) {
        setVoiceError(e.message);
      }
    }
  }, [enabled, getConnectedVoicePeer, isDirectRouteReady]);

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
    /**
     * Half-duplex turn-taking (direct A↔B):
     * - txOwnership: NO_OWNER / SELF / REMOTE for the current link.
     * - txWaitReason: human-readable WAIT reason when REMOTE owns TX.
     * - beginPttTurn(): call before STT; false ⇒ remote busy, do NOT record.
     * - endPttTurn(): release the turn if no message was produced.
     */
    txOwnership,
    txWaitReason,
    beginPttTurn,
    endPttTurn,
  };
}
