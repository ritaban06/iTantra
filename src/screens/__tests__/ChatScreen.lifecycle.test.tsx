/** MOCKED BOUNDARY: validates the screen's store subscription lifecycle only. */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('react-native', () => {
  const React = require('react');
  const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
  return {
    FlatList: host('FlatList'), KeyboardAvoidingView: host('KeyboardAvoidingView'),
    Platform: { OS: 'android' }, StyleSheet: { create: (styles: any) => styles },
    Text: host('Text'), TextInput: host('TextInput'), TouchableOpacity: host('TouchableOpacity'), View: host('View'),
  };
});

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  return { SafeAreaView: (props: any) => React.createElement('SafeAreaView', props, props.children) };
});

jest.mock('../../messages', () => {
  let activeChatSubscriptions = 0;
  const emptySnapshot = { messages: [] };
  const subscribe = jest.fn(() => {
    activeChatSubscriptions++;
    return () => { activeChatSubscriptions--; };
  });
  return {
    getChatSnapshot: () => emptySnapshot,
    getConversation: () => [],
    isChatTransportReady: () => false,
    sendChatMessage: jest.fn(),
    subscribeChatMessages: subscribe,
    __activeChatSubscriptions: () => activeChatSubscriptions,
  };
});

jest.mock('../../hooks/voiceDestinationStore', () => {
  let activeDestinationSubscriptions = 0;
  const subscribe = jest.fn(() => {
    activeDestinationSubscriptions++;
    return () => { activeDestinationSubscriptions--; };
  });
  return {
    getMeshDestinations: () => [],
    subscribeMeshDestinations: subscribe,
    __activeDestinationSubscriptions: () => activeDestinationSubscriptions,
  };
});

// ChatScreen must have no transport ownership; this mock is intentionally
// present to prove neither a BLE call nor a voice-mode mutation occurs.
jest.mock('../../native/NativeBLE', () => ({
  __esModule: true,
  default: { connect: jest.fn(), send: jest.fn(), onDataReceived: jest.fn() },
}));

import ChatScreen from '../ChatScreen';

const messagesMock: any = jest.requireMock('../../messages');
const destinationsMock: any = jest.requireMock('../../hooks/voiceDestinationStore');
const nativeBleMock: any = jest.requireMock('../../native/NativeBLE').default;

describe('ChatScreen lifecycle', () => {
  it('MOCKED BOUNDARY: mount subscribes, unmount unsubscribes, and remount has exactly one active subscription per local store', async () => {
    let first!: TestRenderer.ReactTestRenderer;
    await act(async () => { first = TestRenderer.create(<ChatScreen />); });
    expect(messagesMock.subscribeChatMessages).toHaveBeenCalledTimes(1);
    expect(destinationsMock.subscribeMeshDestinations).toHaveBeenCalledTimes(1);
    expect(messagesMock.__activeChatSubscriptions()).toBe(1);
    expect(destinationsMock.__activeDestinationSubscriptions()).toBe(1);

    await act(async () => { first.unmount(); });
    expect(messagesMock.__activeChatSubscriptions()).toBe(0);
    expect(destinationsMock.__activeDestinationSubscriptions()).toBe(0);

    let second!: TestRenderer.ReactTestRenderer;
    await act(async () => { second = TestRenderer.create(<ChatScreen />); });
    expect(messagesMock.subscribeChatMessages).toHaveBeenCalledTimes(2);
    expect(destinationsMock.subscribeMeshDestinations).toHaveBeenCalledTimes(2);
    expect(messagesMock.__activeChatSubscriptions()).toBe(1);
    expect(destinationsMock.__activeDestinationSubscriptions()).toBe(1);
    expect(nativeBleMock.connect).not.toHaveBeenCalled();
    expect(nativeBleMock.send).not.toHaveBeenCalled();
    expect(nativeBleMock.onDataReceived).not.toHaveBeenCalled();

    await act(async () => { second.unmount(); });
  });
});
