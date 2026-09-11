/**
 * In-memory conversation state for the typed-message application.
 *
 * This store deliberately has no BLE or BITCHAT dependency. The transport
 * service owns delivery; the UI only observes this session-local state.
 */

export type ChatMessageStatus = 'SENDING' | 'SENT' | 'FAILED' | 'RECEIVED';
export type ChatMessageDirection = 'outgoing' | 'incoming';

export interface ChatMessage {
  /** Compact V6A message identity, stable across relay/reassembly. */
  id: string;
  /** Logical remote BITCHAT NodeId; never a native BLE device ID. */
  conversationNodeId: string;
  senderNodeId: string;
  recipientNodeId: string;
  text: string;
  direction: ChatMessageDirection;
  status: ChatMessageStatus;
  time: number;
}

export interface ChatStoreSnapshot {
  messages: ChatMessage[];
}

type Listener = () => void;

let snapshot: ChatStoreSnapshot = { messages: [] };
const listeners = new Set<Listener>();

function publish(messages: ChatMessage[]): void {
  snapshot = { messages };
  listeners.forEach(listener => listener());
}

/** Subscribe to the in-memory chat session. */
export function subscribeChatMessages(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Read the current immutable snapshot. */
export function getChatSnapshot(): ChatStoreSnapshot {
  return snapshot;
}

/** Get one logical conversation, oldest to newest. */
export function getConversation(nodeId: string): ChatMessage[] {
  return snapshot.messages.filter(message => message.conversationNodeId === nodeId);
}

export function addOutgoingChatMessage(message: ChatMessage): void {
  publish([...snapshot.messages, message]);
}

/** Update only a locally-originated message's honest send state. */
export function setOutgoingChatMessageStatus(id: string, status: 'SENT' | 'FAILED'): void {
  publish(snapshot.messages.map(message => (
    message.id === id && message.direction === 'outgoing'
      ? { ...message, status }
      : message
  )));
}

/**
 * Add a locally delivered message once. RelayEngine deduplicates packets;
 * this is the final semantic-message guard, including after V7 completion.
 */
export function addIncomingChatMessage(message: ChatMessage): boolean {
  const duplicate = snapshot.messages.some(existing => (
    existing.direction === 'incoming' &&
    existing.senderNodeId === message.senderNodeId &&
    existing.id === message.id
  ));
  if (duplicate) return false;
  publish([...snapshot.messages, message]);
  return true;
}

/** Test-only reset for the session-local store. */
export function resetChatMessageStore(): void {
  snapshot = { messages: [] };
  listeners.clear();
}
