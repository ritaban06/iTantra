/**
 * REAL APPLICATION INTEGRATION: ChatScreen → ChatMessageService → the real
 * BitChatBLEAdapter. The only mocked boundary is the adapter's BLE send.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('react-native', () => {
  const React = require('react');
  const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
  return {
    FlatList: ({ data = [], renderItem, ListEmptyComponent, ...props }: any) => React.createElement(
      'FlatList', props, data.length
        ? data.map((item: any, index: number) => React.cloneElement(renderItem({ item, index }), { key: index }))
        : ListEmptyComponent,
    ),
    KeyboardAvoidingView: host('KeyboardAvoidingView'),
    Platform: { OS: 'android' },
    StyleSheet: { create: (styles: any) => styles },
    Text: host('Text'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  return { SafeAreaView: (props: any) => React.createElement('SafeAreaView', props, props.children) };
});

import ChatScreen from '../ChatScreen';
import {
  getChatSnapshot,
  registerChatTransport,
  resetChatMessageService,
  resetChatMessageStore,
} from '../../messages';
import * as ChatMessageStore from '../../messages/ChatMessageStore';
import {
  BitChatBLEAdapter,
  decode as decodeBitChat,
  normalizePacketId,
  NODE_ID_BROADCAST,
} from '../../BITCHAT';
import { decodeChatApplicationPayload } from '../../messages/ChatMessageService';
import { decodeWithFallback } from '../../protocol';
import {
  registerMeshDestinationsProvider,
  resetVoiceDestinationStore,
} from '../../hooks/voiceDestinationStore';

const LOCAL = '0x00000000000000a1';
const REMOTE = '0x00000000000000b2';

describe('ChatScreen typed-chat send binding', () => {
  beforeEach(() => {
    resetChatMessageStore();
    resetChatMessageService();
    resetVoiceDestinationStore();
  });

  afterEach(() => {
    resetVoiceDestinationStore();
  });

  it('REAL APPLICATION INTEGRATION: sends one-to-one to the selected logical NodeId through the registered adapter', async () => {
    const sent: Uint8Array[] = [];
    const adapter = new BitChatBLEAdapter({
      localNodeId: LOCAL,
      // MOCKED BOUNDARY: this is the lowest transport edge, after adapter
      // origination and RelayEngine selection have already occurred.
      bleSend: async (_peerId, bytes) => { sent.push(bytes); },
      onLocalDeliver: () => {},
    });
    adapter.registerPeer('ble-remote', REMOTE);
    registerChatTransport({
      localNodeId: adapter.getLocalNodeId(),
      originate: (payload, packetId, destinationNodeId, fragmentCount) =>
        adapter.originate(payload, packetId, destinationNodeId, undefined, fragmentCount),
      canRouteTo: destinationNodeId => destinationNodeId === REMOTE,
    });
    registerMeshDestinationsProvider(() => [
      { nodeId: REMOTE, direct: true, blePeerId: 'ble-remote' },
      { nodeId: NODE_ID_BROADCAST, direct: false },
    ]);

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<ChatScreen />); });
    // The transport's broadcast identity is never presented as a chat peer.
    expect(renderer.root.findAllByProps({ testID: `chat-peer-${NODE_ID_BROADCAST}` })).toHaveLength(0);
    await act(async () => {
      renderer.root.findByProps({ testID: `chat-peer-${REMOTE}` }).props.onPress();
    });
    await act(async () => {
      renderer.root.findByProps({ testID: 'chat-input' }).props.onChangeText('screen-bound chat');
    });
    await act(async () => {
      await renderer.root.findByProps({ testID: 'chat-send' }).props.onPress();
    });

    expect(sent).toHaveLength(1);
    const envelope = decodeBitChat(sent[0]);
    const outgoing = getChatSnapshot().messages[0];
    expect(envelope).toEqual(expect.objectContaining({
      sourceNodeId: LOCAL,
      destinationNodeId: REMOTE,
      packetId: outgoing.id,
    }));
    const applicationPayload = decodeChatApplicationPayload(envelope.payload);
    expect(applicationPayload).not.toBeNull();
    expect(decodeWithFallback(applicationPayload!)).toEqual(expect.objectContaining({
      text: 'screen-bound chat',
      messageId: expect.any(String),
    }));
    expect(outgoing).toEqual(expect.objectContaining({
      id: normalizePacketId(BigInt(outgoing.id)),
      senderNodeId: LOCAL,
      recipientNodeId: REMOTE,
      conversationNodeId: REMOTE,
      text: 'screen-bound chat',
      status: 'SENT',
    }));

    await act(async () => { renderer.unmount(); });
  });

  it('REAL STORE REGRESSION: synchronizes a message published in the render-to-subscription window and unsubscribes on unmount', async () => {
    const realSubscribe = ChatMessageStore.subscribeChatMessages;
    let unsubscribed = false;
    const subscribeSpy = jest.spyOn(ChatMessageStore, 'subscribeChatMessages')
      .mockImplementation((listener) => {
        // This runs after ChatScreen read its initial empty snapshot but before
        // it registers. useSyncExternalStore must re-read and render this real
        // store update rather than leaving the screen stale until another event.
        ChatMessageStore.addIncomingChatMessage({
          id: '0x0000000000000777',
          conversationNodeId: REMOTE,
          senderNodeId: REMOTE,
          recipientNodeId: LOCAL,
          text: 'arrived during subscribe',
          direction: 'incoming',
          status: 'RECEIVED',
          time: Date.now(),
        });
        const unsubscribe = realSubscribe(listener);
        return () => {
          unsubscribed = true;
          unsubscribe();
        };
      });

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<ChatScreen />); });

    expect(renderer.root.findByProps({ testID: `chat-peer-${REMOTE}` })).toBeTruthy();
    expect(getChatSnapshot().messages).toEqual([
      expect.objectContaining({ text: 'arrived during subscribe' }),
    ]);

    await act(async () => { renderer.unmount(); });
    expect(unsubscribed).toBe(true);
    subscribeSpy.mockRestore();
  });
});
