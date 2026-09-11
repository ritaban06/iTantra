/**
 * REAL APPLICATION INTEGRATION: real BitChatBLEAdapter + RelayEngine + the
 * typed-chat application dispatcher. Only bleSend is a mocked boundary.
 */
import {
  BitChatBLEAdapter,
  decode as decodeBitChat,
  normalizePacketId,
  type NodeId,
} from '../../BITCHAT';
import { createSemanticMessage } from '../../semantic';
import { encodeUnrestricted, hashMessageId } from '../../protocol';
import {
  encodeChatApplicationPayload,
  receiveChatApplicationPayload,
  resetChatMessageService,
} from '../ChatMessageService';
import { getChatSnapshot, resetChatMessageStore } from '../ChatMessageStore';

const A = '0x000000000000000a';
const B = '0x000000000000000b';
const C = '0x000000000000000c';

interface SimNode {
  adapter: BitChatBLEAdapter;
  sent: Map<string, Uint8Array[]>;
  localDeliveries: number;
}

function node(localNodeId: NodeId, deliverToChat = false): SimNode {
  const sent = new Map<string, Uint8Array[]>();
  const result: SimNode = {
    adapter: null as unknown as BitChatBLEAdapter,
    sent,
    localDeliveries: 0,
  };
  result.adapter = new BitChatBLEAdapter({
    localNodeId,
    bleSend: async (peer, bytes) => {
      const packets = sent.get(peer) ?? [];
      packets.push(bytes);
      sent.set(peer, packets);
    },
    onLocalDeliver: (payload, fromPeerId, _diagnosticId, sourceNodeId, destinationNodeId) => {
      result.localDeliveries++;
      if (deliverToChat) {
        receiveChatApplicationPayload(payload, {
          fromPeerId,
          sourceNodeId,
          destinationNodeId,
        });
      }
    },
  });
  return result;
}

function connect(left: SimNode, leftBleId: string, leftNodeId: NodeId, right: SimNode, rightBleId: string, rightNodeId: NodeId): void {
  left.adapter.registerPeer(leftBleId, rightNodeId);
  right.adapter.registerPeer(rightBleId, leftNodeId);
}

describe('typed chat through the BITCHAT application boundary', () => {
  beforeEach(() => {
    resetChatMessageStore();
    resetChatMessageService();
  });

  it('REAL APPLICATION INTEGRATION: BITCHAT local delivery decodes typed chat into the received conversation state exactly once', async () => {
    const sender = node(B);
    const receiver = node(C, true);
    connect(sender, 'ble-bc', B, receiver, 'ble-cb', C);

    const semantic = createSemanticMessage('received through the adapter');
    const payload = encodeChatApplicationPayload(encodeUnrestricted(semantic));
    const packetId = normalizePacketId(BigInt(501));
    await sender.adapter.originate(payload, packetId, C);

    const envelope = sender.sent.get('ble-bc')![0];
    await receiver.adapter.receive(envelope, 'ble-cb');
    // Same complete BITCHAT packet: RelayEngine dedup must suppress it before
    // a second application delivery is attempted.
    await receiver.adapter.receive(envelope, 'ble-cb');

    expect(getChatSnapshot().messages).toEqual([
      expect.objectContaining({
        id: normalizePacketId(hashMessageId(semantic.messageId)),
        senderNodeId: B,
        recipientNodeId: C,
        conversationNodeId: B,
        text: 'received through the adapter',
        status: 'RECEIVED',
        direction: 'incoming',
        time: expect.any(Number),
      }),
    ]);
    expect(receiver.localDeliveries).toBe(1);
  });

  it('REAL APPLICATION INTEGRATION: A → B → C relays typed chat without B delivery and preserves application identity at C', async () => {
    const source = node(A);
    const relay = node(B, true);
    const destination = node(C, true);
    connect(source, 'ble-ab', A, relay, 'ble-ba', B);
    connect(relay, 'ble-bc', B, destination, 'ble-cb', C);

    const semantic = createSemanticMessage('multi-hop typed chat');
    const packetId = normalizePacketId(BigInt(502));
    await source.adapter.originate(
      encodeChatApplicationPayload(encodeUnrestricted(semantic)),
      packetId,
      C,
    );

    const aToB = source.sent.get('ble-ab')![0];
    expect(decodeBitChat(aToB)).toEqual(expect.objectContaining({
      sourceNodeId: A,
      destinationNodeId: C,
      packetId,
    }));
    await relay.adapter.receive(aToB, 'ble-ba');
    expect(relay.localDeliveries).toBe(0);
    expect(getChatSnapshot().messages).toHaveLength(0);

    const bToC = relay.sent.get('ble-bc')![0];
    expect(decodeBitChat(bToC)).toEqual(expect.objectContaining({
      sourceNodeId: A,
      destinationNodeId: C,
      packetId,
    }));
    await destination.adapter.receive(bToC, 'ble-cb');

    expect(getChatSnapshot().messages).toEqual([
      expect.objectContaining({
        id: normalizePacketId(hashMessageId(semantic.messageId)),
        senderNodeId: A,
        recipientNodeId: C,
        text: 'multi-hop typed chat',
        status: 'RECEIVED',
      }),
    ]);
  });
});
