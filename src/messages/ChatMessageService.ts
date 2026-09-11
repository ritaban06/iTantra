/**
 * Typed-chat application service.
 *
 * It is intentionally above the transport: callers supply logical NodeIds,
 * while the already-mounted BITCHAT adapter performs framing, relay, BLE
 * transmission, packet deduplication, and peer management.
 */

import { HEADER_SIZE as BITCHAT_HEADER_SIZE, normalizePacketId } from '../BITCHAT';
import {
  decodeWithFallback,
  encodeUnrestricted,
  hashMessageId,
  parseHeader,
  Reassembler,
  splitV6AForBudget,
  V6B_MAX_PAYLOAD_SIZE,
  V7_HEADER_SIZE,
  V7_MARKER,
} from '../protocol';
import { createSemanticMessage } from '../semantic';
import {
  addIncomingChatMessage,
  addOutgoingChatMessage,
  setOutgoingChatMessageStatus,
  type ChatMessage,
} from './ChatMessageStore';

// Application discriminator outside V6A. Voice continues to use its original
// raw V6A/V7 payloads, so it remains byte-for-byte compatible.
const CHAT_MAGIC = [0x49, 0x54, 0x43, 0x01] as const; // "ITC", version 1
const CHAT_HEADER_SIZE = CHAT_MAGIC.length;
const UINT64_MASK = BigInt('0xffffffffffffffff');

export interface ChatTransport {
  localNodeId: string;
  /** Existing BitChatBLEAdapter.originate, not a native BLE sender. */
  originate: (
    payload: Uint8Array,
    packetId: string,
    destinationNodeId: string,
    fragmentCount: number,
  ) => Promise<number>;
  /** True only when the existing mesh has a usable forwarding peer. */
  canRouteTo: (destinationNodeId: string) => boolean;
}

export interface ChatDeliveryMeta {
  sourceNodeId?: string;
  destinationNodeId?: string;
  fromPeerId?: string;
}

let chatTransport: ChatTransport | null = null;
let chatReassembler = new Reassembler();

/** Bind the one adapter owned by useBLEVoiceMode to this application service. */
export function registerChatTransport(transport: ChatTransport | null): void {
  chatTransport = transport;
}

export function isChatTransportReady(destinationNodeId?: string): boolean {
  if (!chatTransport) return false;
  return destinationNodeId ? chatTransport.canRouteTo(destinationNodeId) : true;
}

/** Wrap an existing V6A or V7 payload as typed-chat application data. */
export function encodeChatApplicationPayload(payload: Uint8Array): Uint8Array {
  const wrapped = new Uint8Array(CHAT_HEADER_SIZE + payload.length);
  wrapped.set(CHAT_MAGIC, 0);
  wrapped.set(payload, CHAT_HEADER_SIZE);
  return wrapped;
}

/** Return the V6A/V7 payload only when this belongs to typed chat. */
export function decodeChatApplicationPayload(payload: Uint8Array): Uint8Array | null {
  if (payload.length <= CHAT_HEADER_SIZE) return null;
  for (let index = 0; index < CHAT_HEADER_SIZE; index++) {
    if (payload[index] !== CHAT_MAGIC[index]) return null;
  }
  return payload.slice(CHAT_HEADER_SIZE);
}

function compactMessageId(messageId: string): string {
  return normalizePacketId(hashMessageId(messageId));
}

function toIncomingMessage(
  semantic: { messageId: string; text: string },
  meta: ChatDeliveryMeta,
): ChatMessage {
  const senderNodeId = meta.sourceNodeId ?? meta.fromPeerId ?? 'unknown';
  return {
    id: normalizePacketId(BigInt(semantic.messageId)),
    conversationNodeId: senderNodeId,
    senderNodeId,
    recipientNodeId: meta.destinationNodeId ?? chatTransport?.localNodeId ?? 'unknown',
    text: semantic.text,
    direction: 'incoming',
    status: 'RECEIVED',
    time: Date.now(),
  };
}

/**
 * Receive an already locally-delivered BITCHAT payload.
 *
 * Returns true only for chat payloads. Non-chat payloads must continue to the
 * established voice pipeline and therefore can never trigger chat TTS/UI.
 */
export function receiveChatApplicationPayload(payload: Uint8Array, meta: ChatDeliveryMeta): boolean {
  const applicationPayload = decodeChatApplicationPayload(payload);
  if (!applicationPayload) return false;

  let semantic = null;
  if (applicationPayload[0] === V7_MARKER) {
    try {
      const header = parseHeader(applicationPayload);
      const sourceKey = meta.sourceNodeId ?? meta.fromPeerId ?? 'unknown';
      const result = chatReassembler.addFragment(
        sourceKey,
        header,
        applicationPayload.slice(V7_HEADER_SIZE),
      );
      if (result.status !== 'complete') return true;
      semantic = decodeWithFallback(result.v6aPacket);
    } catch {
      return true;
    }
  } else {
    semantic = decodeWithFallback(applicationPayload);
  }

  if (semantic) addIncomingChatMessage(toIncomingMessage(semantic, meta));
  return true;
}

/**
 * Create and originate one typed chat message through the registered BITCHAT
 * adapter. SENT means at least one existing RelayEngine forwarding operation
 * accepted every packet; it is not a delivery/read receipt.
 */
export async function sendChatMessage(destinationNodeId: string, text: string): Promise<ChatMessage> {
  const normalizedText = text.trim();
  if (!normalizedText) throw new Error('Message cannot be empty');

  const semantic = createSemanticMessage(normalizedText);
  const messageId = compactMessageId(semantic.messageId);
  const localNodeId = chatTransport?.localNodeId ?? 'unknown';
  const outgoing: ChatMessage = {
    id: messageId,
    conversationNodeId: destinationNodeId,
    senderNodeId: localNodeId,
    recipientNodeId: destinationNodeId,
    text: normalizedText,
    direction: 'outgoing',
    status: 'SENDING',
    time: Date.now(),
  };
  addOutgoingChatMessage(outgoing);

  const transport = chatTransport;
  if (!transport || !transport.canRouteTo(destinationNodeId)) {
    setOutgoingChatMessageStatus(messageId, 'FAILED');
    throw new Error('No connected mesh route to this node');
  }

  try {
    const v6a = encodeUnrestricted(semantic);
    // The chat discriminator shares the existing V6B/BITCHAT payload budget.
    const chunkBudget = V6B_MAX_PAYLOAD_SIZE - BITCHAT_HEADER_SIZE - CHAT_HEADER_SIZE;
    const fragments = splitV6AForBudget(v6a, chunkBudget);

    if (fragments.length === 0) {
      const forwarded = await transport.originate(
        encodeChatApplicationPayload(v6a),
        messageId,
        destinationNodeId,
        1,
      );
      if (forwarded === 0) throw new Error('No mesh peer accepted the message');
    } else {
      for (const fragment of fragments) {
        const fragmentPacketId = normalizePacketId(
          (hashMessageId(semantic.messageId) + BigInt(fragment.header.fragmentIndex)) & UINT64_MASK,
        );
        const forwarded = await transport.originate(
          encodeChatApplicationPayload(fragment.payload),
          fragmentPacketId,
          destinationNodeId,
          fragments.length,
        );
        if (forwarded === 0) throw new Error('No mesh peer accepted a message fragment');
      }
    }

    setOutgoingChatMessageStatus(messageId, 'SENT');
    return { ...outgoing, status: 'SENT' };
  } catch (error) {
    setOutgoingChatMessageStatus(messageId, 'FAILED');
    throw error;
  }
}

/** Test-only reset for singleton service state. */
export function resetChatMessageService(): void {
  chatTransport = null;
  chatReassembler = new Reassembler();
}
