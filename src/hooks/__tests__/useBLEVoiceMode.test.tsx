/**
 * V9E Step 6 tests — per-peer V8 reliability inside useBLEVoiceMode.
 *
 * The hook's native dependencies are replaced with controllable fakes:
 * - react-native: NativeEventEmitter (captured instances) + NativeModules
 * - ../native/NativeBLE: controllable events + spies on send/getConnectionState
 * - ../native/NativeSTT: muteMic/unmuteMic spies
 *
 * The BITCHAT adapter is deliberately prevented from initializing (the
 * NodeIdStore storage promise never resolves), so outbound speech goes
 * through the DIRECT V6B + V8 reliability path, which is what Step 6 makes
 * per-peer. All assertions decode the real frames that were sent to verify
 * targeting, sequencing, and isolation.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import {
  useBLEVoiceMode,
} from '../useBLEVoiceMode';
import ChatScreen from '../../screens/ChatScreen';
import {
  v6bEncode,
  v6bDecode,
  V6B_FRAME_ACK,
  V6B_FRAME_BITCHAT,
  V6B_FRAME_NACK,
  V6B_FRAME_V6A_MESSAGE,
  V6B_FRAME_TX_CONTROL,
  TX_OP_GRANT,
  TX_OP_REQUEST,
  V6B_VERSION,
  V7_MARKER,
  parseHeader,
  ReliabilityManager,
  encodeUnrestricted,
  decodeWithFallback,
  splitV6AForBudget,
  V6B_MAX_PAYLOAD_SIZE,
  V7_HEADER_SIZE,
  buildTxControlFrame,
  decodeTxControlPayload,
} from '../../protocol';
import { createSemanticMessage } from '../../semantic';
import {
  BitChatBLEAdapter,
  decode as bitChatDecode,
  encode as bitChatEncode,
  encodeDiscovery,
  PACKET_TYPE_ANNOUNCE,
  PACKET_TYPE_DATA,
  PACKET_TYPE_DISCOVERY,
  DEFAULT_TTL,
  FLAGS_NONE,
  HEADER_SIZE as BITCHAT_HEADER_SIZE,
  NODE_ID_BROADCAST,
  normalizeNodeId,
  normalizePacketId,
} from '../../BITCHAT';
import type { BitChatPacket } from '../../BITCHAT';
import {
  decodeChatApplicationPayload,
  encodeChatApplicationPayload,
  getChatSnapshot,
  isChatTransportReady,
  resetChatMessageService,
  resetChatMessageStore,
} from '../../messages';
import {
  getVoiceDestinationNodeId,
  setVoiceDestinationNodeId,
  resetVoiceDestinationStore,
} from '../voiceDestinationStore';

// ── react-native fake (fully self-contained factory) ───────────────────

jest.mock('react-native', () => {
  // 'hang' keeps the BITCHAT adapter from ever initializing (direct V6B path
  // for Step 6 tests). 'resolve' lets the adapter initialize (mesh path for
  // Step 7 integration tests).
  let storageMode: 'hang' | 'resolve' = 'hang';
  // Per-test AsyncStorage contents. Step 11 multi-phone tests wipe/prime
  // this so each simulated phone gets its own BITCHAT node identity.
  let storageMap: Record<string, string | null> = {};

  const emitterInstances: MockSttEmitter[] = [];

  class MockSttEmitter {
    private handlers = new Map<string, Set<(event?: any) => void>>();
    constructor(_nativeModule?: any) {
      emitterInstances.push(this);
    }
    addListener(eventType: string, cb: (event?: any) => void) {
      let set = this.handlers.get(eventType);
      if (!set) {
        set = new Set();
        this.handlers.set(eventType, set);
      }
      set.add(cb);
      return {
        remove: () => set!.delete(cb),
      };
    }
    removeAllListeners(eventType?: string) {
      if (eventType) {
        this.handlers.delete(eventType);
      } else {
        this.handlers.clear();
      }
    }
    emit(eventType: string, event?: any) {
      const set = this.handlers.get(eventType);
      if (set) {
        Array.from(set).forEach((cb) => cb(event));
      }
    }
  }

  const React = require('react');
  const host = (name: string) => (props: any) => React.createElement(name, props, props.children);

  return {
    NativeEventEmitter: MockSttEmitter,
    NativeModules: {
      NativeSTT: { addListener: jest.fn(), removeListeners: jest.fn() },
      NativeTTS: {
        speak: jest.fn(async () => {}),
      },
      AsyncStorage: {
        getItem: jest.fn((key: string) =>
          storageMode === 'hang'
            ? new Promise(() => {})
            : Promise.resolve(key in storageMap ? storageMap[key] : null),
        ),
        setItem: jest.fn(async (key: string, value: string) => {
          storageMap[key] = value;
        }),
      },
    },
    __emitterInstances: emitterInstances,
    __clearEmitters: () => {
      emitterInstances.length = 0;
    },
    __setStorageMode: (mode: 'hang' | 'resolve') => {
      storageMode = mode;
    },
    __setStorageMap: (map: Record<string, string | null>) => {
      storageMap = map;
    },
    __getStorageMap: () => ({ ...storageMap }),
    FlatList: ({ data = [], renderItem, ListEmptyComponent, ...props }: any) => React.createElement(
      'FlatList',
      props,
      data.length
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

const rnMock: any = jest.requireMock('react-native');
const setStorageMode = rnMock.__setStorageMode as (mode: 'hang' | 'resolve') => void;
const setStorageMap = rnMock.__setStorageMap as (map: Record<string, string | null>) => void;
const getStorageMap = rnMock.__getStorageMap as () => Record<string, string | null>;

// ── NativeSTT fake ──────────────────────────────────────────────────────

jest.mock('../../native/NativeSTT', () => ({
  __esModule: true,
  default: {
    muteMic: jest.fn(),
    unmuteMic: jest.fn(),
  },
}));

const mockNativeSTT: any = jest.requireMock('../../native/NativeSTT').default;

// ── NativeBLE fake (fully self-contained factory) ──────────────────────

jest.mock('../../native/NativeBLE', () => {
  const listeners = new Map<string, Set<(event?: any) => void>>();
  let connectionInfo: any = { state: 'IDLE', deviceId: '', mtu: 23 };
  let connectedDeviceIds: string[] = [];
  let peerConnectionInfo: Record<string, any> = {};

  const subscribe = (name: string, cb: (event?: any) => void) => {
    let set = listeners.get(name);
    if (!set) {
      set = new Set();
      listeners.set(name, set);
    }
    set.add(cb);
    return { remove: () => set!.delete(cb) };
  };

  const getConnectedDeviceIds = jest.fn(async () => [...connectedDeviceIds]);
  const nativeApi: any = {
    getDeviceId: jest.fn(async () => 'LOCAL'),
    isBluetoothEnabled: jest.fn(async () => true),
    getConnectionState: jest.fn(async (deviceId?: string) =>
      deviceId && peerConnectionInfo[deviceId]
        ? peerConnectionInfo[deviceId]
        : connectionInfo,
    ),
    send: jest.fn(async () => true),
    disconnect: jest.fn(async () => true),
    connect: jest.fn(async () => true),
    onDataReceived: (cb: (event?: any) => void) => subscribe('BLE_DATA_RECEIVED', cb),
    onDisconnected: (cb: (event?: any) => void) => subscribe('BLE_DISCONNECTED', cb),
    onConnected: (cb: (event?: any) => void) => subscribe('BLE_CONNECTED', cb),
    onSendFailed: (cb: (event?: any) => void) => subscribe('BLE_SEND_FAILED', cb),
    onSendSuccess: (cb: (event?: any) => void) => subscribe('BLE_SEND_SUCCESS', cb),
  };

  return {
    __esModule: true,
    default: nativeApi,
    __emit: (name: string, event?: any) => {
      if (event?.deviceId && name === 'BLE_CONNECTED' && !connectedDeviceIds.includes(event.deviceId)) {
        connectedDeviceIds.push(event.deviceId);
      }
      if (event?.deviceId && name === 'BLE_DISCONNECTED') {
        connectedDeviceIds = connectedDeviceIds.filter((id) => id !== event.deviceId);
      }
      const set = listeners.get(name);
      if (set) {
        Array.from(set).forEach((cb) => cb(event));
      }
    },
    __clearListeners: () => listeners.clear(),
    __setConnectionInfo: (info: any) => {
      connectionInfo = info;
    },
    __enablePeerListApi: () => {
      nativeApi.getConnectedDeviceIds = getConnectedDeviceIds;
    },
    __disablePeerListApi: () => {
      delete nativeApi.getConnectedDeviceIds;
    },
    __setConnectedDeviceIds: (ids: string[]) => {
      connectedDeviceIds = [...ids];
      nativeApi.getConnectedDeviceIds = getConnectedDeviceIds;
    },
    __setPeerConnectionInfo: (info: Record<string, any>) => {
      peerConnectionInfo = { ...info };
    },
  };
});

const nativeMock: any = jest.requireMock('../../native/NativeBLE');
const mockNativeBLE = nativeMock.default;
const emitBLE = nativeMock.__emit as (name: string, event?: any) => void;
const setConnectionInfo = nativeMock.__setConnectionInfo as (info: any) => void;
const setConnectedDeviceIds = nativeMock.__setConnectedDeviceIds as (ids: string[]) => void;
const setPeerConnectionInfo = nativeMock.__setPeerConnectionInfo as (info: Record<string, any>) => void;
const disablePeerListApi = nativeMock.__disablePeerListApi as () => void;

// ── Shared helpers ──────────────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  let charStr = '';
  for (let i = 0; i < bytes.length; i++) {
    charStr += String.fromCharCode(bytes[i]);
  }
  return (globalThis as any).btoa(charStr);
}

function base64ToBytes(base64: string): Uint8Array {
  const decoded = (globalThis as any).atob(base64);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) {
    bytes[i] = decoded.charCodeAt(i) & 0xff;
  }
  return bytes;
}

/** All base64 payloads the fake native was asked to send to a device. */
function sendsTo(deviceId: string): string[] {
  return mockNativeBLE.send.mock.calls
    .filter((call: any[]) => call[1] === deviceId)
    .map((call: any[]) => call[0] as string);
}

function clearSendCalls() {
  mockNativeBLE.send.mockClear();
}

interface FrameInfo {
  base64: string;
  frame: any; // V6BDecodedFrame
  sequence: number;
  frameType: number;
}

function decodeSendsTo(deviceId: string): FrameInfo[] {
  return sendsTo(deviceId).map((base64) => {
    const frame = v6bDecode(base64ToBytes(base64));
    return { base64, frame, sequence: frame.sequence, frameType: frame.frameType };
  });
}

/** Decode the semantic text carried by a single-frame V6B V6A payload. */
function textOfFrame(base64: string): string {
  const frame = v6bDecode(base64ToBytes(base64));
  const msg = decodeWithFallback(frame.payload);
  if (!msg) throw new Error('frame payload did not decode to a semantic message');
  return msg.text;
}

/** messageId of a single-frame V6B V6A payload. */
function messageIdOfFrame(base64: string): string {
  const frame = v6bDecode(base64ToBytes(base64));
  const msg = decodeWithFallback(frame.payload);
  if (!msg) throw new Error('frame payload did not decode to a semantic message');
  return msg.messageId;
}

function buildAckBase64(messageId: string): string {
  const frame = v6bEncode(0, V6B_FRAME_ACK, ReliabilityManager.buildAckPayload(messageId));
  return bytesToBase64(frame);
}

function buildNackBase64(groupId: number): string {
  const frame = v6bEncode(0, V6B_FRAME_NACK, ReliabilityManager.buildNackPayload(groupId, 0x02));
  return bytesToBase64(frame);
}

function buildDataFrameBase64(payload: Uint8Array, sequence: number = 0): string {
  const frame = v6bEncode(sequence, V6B_FRAME_V6A_MESSAGE, payload);
  return bytesToBase64(frame);
}

function buildRemoteAnnounceFrame(nodeId: string): string {
  const remote = new BitChatBLEAdapter({
    localNodeId: nodeId,
    bleSend: async () => {},
    onLocalDeliver: () => {},
  });
  return bytesToBase64(v6bEncode(0, V6B_FRAME_BITCHAT, remote.createAnnouncePacket()));
}

function semanticPayload(text: string): { v6a: Uint8Array; messageId: string } {
  const semanticMsg = createSemanticMessage(text, { language: 'en' });
  return { v6a: encodeUnrestricted(semanticMsg), messageId: semanticMsg.messageId };
}

type HookApi = ReturnType<typeof useBLEVoiceMode>;

async function renderHook() {
  const apiRef: { current: HookApi | null } = { current: null };
  let renderer!: TestRenderer.ReactTestRenderer;

  const Harness = () => {
    apiRef.current = useBLEVoiceMode('en');
    return null;
  };

  await act(async () => {
    renderer = TestRenderer.create(<Harness />);
  });
  await act(async () => {});

  return {
    renderer,
    api: () => apiRef.current!,
  };
}

/** Mount the real hook and ChatScreen together; no chat transport is injected. */
async function renderChatWithProductionHook() {
  const apiRef: { current: HookApi | null } = { current: null };
  let renderer!: TestRenderer.ReactTestRenderer;
  const Harness = () => {
    apiRef.current = useBLEVoiceMode('en');
    return <ChatScreen />;
  };

  await act(async () => {
    renderer = TestRenderer.create(<Harness />);
  });
  await act(async () => {});
  return { renderer, api: () => apiRef.current! };
}

/** Enable voice mode targeting a connected BLE peer (deviceId). */
async function enableVoice(deviceId: string) {
  setConnectionInfo({ state: 'CONNECTED', deviceId, mtu: 512 });
  await act(async () => {
    await api().toggleVoiceMode();
  });
  await act(async () => {});
}

/** Emit an STT final result into the latest captured STT emitter. */
function sttResult(transcript: string) {
  const instances: any[] = rnMock.__emitterInstances;
  const emitter = instances[instances.length - 1];
  act(() => {
    emitter.emit('STT_RESULT', { transcript });
  });
}

const flush = async () => {
  await act(async () => {});
};

const advance = async (ms: number) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await flush();
};

let api: () => HookApi;

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  nativeMock.__clearListeners();
  rnMock.__clearEmitters();
  setStorageMode('hang'); // default: direct V6B path for Step 6 tests
  setStorageMap({}); // no persisted identity by default
  setConnectionInfo({ state: 'IDLE', deviceId: '', mtu: 23 });
  setConnectedDeviceIds([]);
  disablePeerListApi();
  setPeerConnectionInfo({});
  mockNativeSTT.muteMic.mockClear();
  mockNativeSTT.unmuteMic.mockClear();
  resetChatMessageStore();
  resetChatMessageService();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useBLEVoiceMode — authoritative Link enablement target', () => {
  it('enables Link from a Discovery-created connection that predates hook mount', async () => {
    setStorageMode('resolve');
    setConnectedDeviceIds(['DISCOVERY_PEER']);
    setPeerConnectionInfo({
      DISCOVERY_PEER: { state: 'CONNECTED', deviceId: 'DISCOVERY_PEER', mtu: 512 },
    });
    setConnectionInfo({ state: 'IDLE', deviceId: '', mtu: 23 });

    const r = await renderHook();
    api = r.api;

    await act(async () => {
      await api().toggleVoiceMode();
    });

    expect(api().enabled).toBe(true);
    expect(api().status).toBe('CONNECTING_MESH_ROUTE');
    expect(api().voiceError).toBeNull();
    expect(mockNativeBLE.getConnectedDeviceIds).toHaveBeenCalled();
    expect(mockNativeBLE.getConnectionState).toHaveBeenCalledWith('DISCOVERY_PEER');

    await act(async () => {
      emitBLE('BLE_DATA_RECEIVED', {
        data: buildRemoteAnnounceFrame('0x00000000000000bb'),
        fromDevice: 'DISCOVERY_PEER',
      });
    });
    await act(async () => {});
    expect(api().status).toBe('WAITING_FOR_SPEECH');
  });

  it('uses the first verified native key deterministically with multiple connected peers', async () => {
    setStorageMode('resolve');
    setConnectedDeviceIds(['PEER_B', 'PEER_A']);
    setPeerConnectionInfo({
      PEER_B: { state: 'CONNECTED', deviceId: 'PEER_B', mtu: 512 },
      PEER_A: { state: 'CONNECTED', deviceId: 'PEER_A', mtu: 247 },
    });
    setConnectionInfo({ state: 'IDLE', deviceId: '', mtu: 23 });

    const r = await renderHook();
    api = r.api;

    await act(async () => {
      await api().toggleVoiceMode();
    });
    await act(async () => {
      emitBLE('BLE_DATA_RECEIVED', {
        data: buildRemoteAnnounceFrame('0x00000000000000bb'),
        fromDevice: 'PEER_B',
      });
    });
    await act(async () => {});
    mockNativeBLE.send.mockClear();
    mockNativeBLE.getConnectionState.mockClear();

    const turn = api().beginPttTurn();
    await act(async () => {});

    expect(mockNativeBLE.getConnectionState).toHaveBeenCalledWith('PEER_B');
    expect(mockNativeBLE.getConnectionState).not.toHaveBeenCalledWith('PEER_A');
    expect(mockNativeBLE.send.mock.calls.some((call: any[]) => call[1] === 'PEER_B')).toBe(true);
    expect(mockNativeBLE.send.mock.calls.some((call: any[]) => call[1] === 'PEER_A')).toBe(false);

    await act(async () => {
      jest.advanceTimersByTime(1600);
    });
    expect(await turn).toBe(false);
  });

  it('retains the correct error when no connected native peer exists', async () => {
    setConnectedDeviceIds([]);
    setConnectionInfo({ state: 'CONNECTED', deviceId: 'LEGACY_ONLY', mtu: 512 });

    const r = await renderHook();
    api = r.api;

    await act(async () => {
      await api().toggleVoiceMode();
    });

    expect(api().enabled).toBe(false);
    expect(api().voiceError).toBe('Connect to a device first');
    expect(mockNativeBLE.getConnectionState).not.toHaveBeenCalled();
  });

  it('clears a stale Link error after a later exact-peer enable succeeds', async () => {
    const r = await renderHook();
    api = r.api;

    await act(async () => {
      await api().toggleVoiceMode();
    });
    expect(api().voiceError).toBe('Connect to a device first');

    setConnectedDeviceIds(['FRESH_PEER']);
    setPeerConnectionInfo({
      FRESH_PEER: { state: 'CONNECTED', deviceId: 'FRESH_PEER', mtu: 512 },
    });
    await act(async () => {
      await api().toggleVoiceMode();
    });

    expect(api().enabled).toBe(true);
    expect(api().voiceError).toBeNull();
  });

  it('uses the current reconnect key instead of the stale prior key', async () => {
    setStorageMode('resolve');
    setConnectedDeviceIds(['OLD_PEER']);
    setPeerConnectionInfo({
      OLD_PEER: { state: 'CONNECTED', deviceId: 'OLD_PEER', mtu: 512 },
    });

    const r = await renderHook();
    api = r.api;
    await act(async () => {
      await api().toggleVoiceMode();
    });
    await act(async () => {
      emitBLE('BLE_DATA_RECEIVED', {
        data: buildRemoteAnnounceFrame('0x00000000000000bb'),
        fromDevice: 'OLD_PEER',
      });
    });
    await act(async () => {});
    await act(async () => {
      await api().toggleVoiceMode();
    });

    setConnectedDeviceIds(['NEW_PEER']);
    setPeerConnectionInfo({
      NEW_PEER: { state: 'CONNECTED', deviceId: 'NEW_PEER', mtu: 512 },
    });
    mockNativeBLE.getConnectionState.mockClear();
    mockNativeBLE.send.mockClear();

    await act(async () => {
      await api().toggleVoiceMode();
    });
    expect(api().enabled).toBe(true);
    expect(api().status).toBe('CONNECTING_MESH_ROUTE');
    expect(mockNativeBLE.getConnectionState).toHaveBeenCalledWith('NEW_PEER');
    expect(mockNativeBLE.getConnectionState).not.toHaveBeenCalledWith('OLD_PEER');

    const turn = api().beginPttTurn();
    await act(async () => {});
    const txControlTargets = mockNativeBLE.send.mock.calls
      .filter((call: any[]) => {
        try {
          return v6bDecode(base64ToBytes(call[0])).frameType === V6B_FRAME_TX_CONTROL;
        } catch {
          return false;
        }
      })
      .map((call: any[]) => call[1]);
    expect(txControlTargets).not.toContain('NEW_PEER');
    expect(txControlTargets).not.toContain('OLD_PEER');
    expect(await turn).toBe(false);
  });

  it('does not start a PTT turn while the direct ANNOUNCE route is pending', async () => {
    setStorageMode('resolve');
    setConnectedDeviceIds(['ROUTE_PENDING']);
    setPeerConnectionInfo({
      ROUTE_PENDING: { state: 'CONNECTED', deviceId: 'ROUTE_PENDING', mtu: 512 },
    });

    const r = await renderHook();
    api = r.api;
    await act(async () => {
      await api().toggleVoiceMode();
    });

    expect(api().status).toBe('CONNECTING_MESH_ROUTE');
    const sendsBefore = mockNativeBLE.send.mock.calls.length;
    expect(await api().beginPttTurn()).toBe(false);
    expect(mockNativeBLE.send.mock.calls.length).toBe(sendsBefore);
    expect(api().status).toBe('CONNECTING_MESH_ROUTE');
  });

  it('allows PTT ownership only after the exact direct route is registered', async () => {
    setStorageMode('resolve');
    setConnectedDeviceIds(['ROUTE_READY']);
    setPeerConnectionInfo({
      ROUTE_READY: { state: 'CONNECTED', deviceId: 'ROUTE_READY', mtu: 512 },
    });

    const r = await renderHook();
    api = r.api;
    await act(async () => {
      await api().toggleVoiceMode();
    });
    expect(api().status).toBe('CONNECTING_MESH_ROUTE');

    await act(async () => {
      emitBLE('BLE_DATA_RECEIVED', {
        data: buildRemoteAnnounceFrame('0x00000000000000cc'),
        fromDevice: 'ROUTE_READY',
      });
    });
    await act(async () => {});
    expect(api().status).toBe('WAITING_FOR_SPEECH');

    const turn = api().beginPttTurn();
    await act(async () => {});
    const requestCall = mockNativeBLE.send.mock.calls.find((call: any[]) => {
      if (call[1] !== 'ROUTE_READY') return false;
      try {
        const frame = v6bDecode(base64ToBytes(call[0]));
        const control = decodeTxControlPayload(frame.payload);
        return control?.op === TX_OP_REQUEST;
      } catch {
        return false;
      }
    });
    expect(requestCall).toBeDefined();
    const requestFrame = v6bDecode(base64ToBytes(requestCall![0]));
    const request = decodeTxControlPayload(requestFrame.payload)!;
    await act(async () => {
      emitBLE('BLE_DATA_RECEIVED', {
        data: bytesToBase64(buildTxControlFrame(1, {
          op: TX_OP_GRANT,
          txId: 7,
          requestId: request.requestId,
        })),
        fromDevice: 'ROUTE_READY',
      });
    });
    expect(await turn).toBe(true);
  });
});

// ── Tests ──────────────────────────────────────────────────────────────

describe('useBLEVoiceMode — per-peer V8 reliability', () => {
  it('1-4/7. creates independent per-peer reliability state for C and D with independent sequences', async () => {
    const r = await renderHook();
    api = r.api;

    // Enable with peer C and speak → one DATA frame to C at seq 0.
    await enableVoice('C');
    sttResult('first message');
    await flush();

    let cFrames = decodeSendsTo('C');
    expect(cFrames.length).toBe(1);
    expect(cFrames[0].frameType).toBe(V6B_FRAME_V6A_MESSAGE);
    expect(cFrames[0].sequence).toBe(0);
    expect(textOfFrame(cFrames[0].base64)).toBe('first message');
    expect(sendsTo('D')).toHaveLength(0);

    // Switch the voice target to D while still enabled → its own manager,
    // and D's sequence stream starts at 0 (independent of C's manager).
    setConnectionInfo({ state: 'CONNECTED', deviceId: 'D', mtu: 512 });
    sttResult('second message');
    await flush();

    const dFrames = decodeSendsTo('D');
    expect(dFrames.length).toBe(1);
    expect(dFrames[0].sequence).toBe(0);
    expect(textOfFrame(dFrames[0].base64)).toBe('second message');

    // C's stream was untouched by D's transmission (C still at seq 0 so far).
    expect(decodeSendsTo('C').map((f) => f.sequence)).toEqual([0]);
  });

  it('5-6/19. C and D retransmissions run concurrently to the correct peer with per-peer sequences', async () => {
    const r = await renderHook();
    api = r.api;

    await enableVoice('C');
    sttResult('to C');
    await flush();

    setConnectionInfo({ state: 'CONNECTED', deviceId: 'D', mtu: 512 });
    sttResult('to D');
    await flush();

    clearSendCalls();

    // ACK timeout for both managers → each retransmits to its own peer.
    await advance(2000);

    const cFrames = decodeSendsTo('C');
    const dFrames = decodeSendsTo('D');
    expect(cFrames.length).toBe(1);
    expect(dFrames.length).toBe(1);
    expect(cFrames[0].frameType).toBe(V6B_FRAME_V6A_MESSAGE);
    expect(dFrames[0].frameType).toBe(V6B_FRAME_V6A_MESSAGE);
    // New sequences drawn from each peer's own SequenceManager.
    expect(cFrames[0].sequence).toBe(1);
    expect(dFrames[0].sequence).toBe(1);
    // Each retransmission preserved its own payload.
    expect(textOfFrame(cFrames[0].base64)).toBe('to C');
    expect(textOfFrame(dFrames[0].base64)).toBe('to D');

    // A second timeout advances each stream by one more, still per peer.
    await advance(2000);
    const cFrames2 = decodeSendsTo('C');
    const dFrames2 = decodeSendsTo('D');
    expect(cFrames2.map((f) => f.sequence)).toEqual([1, 2]);
    expect(dFrames2.map((f) => f.sequence)).toEqual([1, 2]);
  });

  it('8-9/26. ACK from the wrong peer never resolves C; ACK from C completes it', async () => {
    const r = await renderHook();
    api = r.api;

    await enableVoice('C');
    sttResult('message to C');
    await flush();

    const initial = decodeSendsTo('C')[0];
    const msgId = messageIdOfFrame(initial.base64);

    // ACK for C's message arriving from D (wrong peer) must NOT resolve C.
    act(() => {
      emitBLE('BLE_DATA_RECEIVED', { data: buildAckBase64(msgId), fromDevice: 'D' });
    });
    await flush();
    clearSendCalls();
    await advance(2000);
    // C still retransmits → its message is still active.
    expect(decodeSendsTo('C').length).toBe(1);
    expect(decodeSendsTo('D').length).toBe(0);

    // Correct ACK from C resolves the message.
    clearSendCalls();
    act(() => {
      emitBLE('BLE_DATA_RECEIVED', { data: buildAckBase64(msgId), fromDevice: 'C' });
    });
    await flush();
    clearSendCalls();
    await advance(2000);
    await advance(2000);
    // No further retransmissions after a successful ACK.
    expect(sendsTo('C')).toHaveLength(0);
    expect(sendsTo('D')).toHaveLength(0);
  });

  it('9/26b. ACK from D resolves only D while C remains pending', async () => {
    const r = await renderHook();
    api = r.api;

    await enableVoice('C');
    sttResult('pending C');
    await flush();
    const cMsgId = messageIdOfFrame(decodeSendsTo('C')[0].base64);

    setConnectionInfo({ state: 'CONNECTED', deviceId: 'D', mtu: 512 });
    sttResult('pending D');
    await flush();
    const dMsgId = messageIdOfFrame(decodeSendsTo('D')[0].base64);

    // ACK D's message from D.
    act(() => {
      emitBLE('BLE_DATA_RECEIVED', { data: buildAckBase64(dMsgId), fromDevice: 'D' });
    });
    await flush();
    clearSendCalls();

    await advance(2000);
    // D is done (no more D sends), C keeps retrying to C.
    expect(sendsTo('D')).toHaveLength(0);
    const cRetries = decodeSendsTo('C');
    expect(cRetries.length).toBe(1);
    expect(textOfFrame(cRetries[0].base64)).toBe('pending C');

    // Now ACK C.
    clearSendCalls();
    act(() => {
      emitBLE('BLE_DATA_RECEIVED', { data: buildAckBase64(cMsgId), fromDevice: 'C' });
    });
    await flush();
    await advance(2000);
    expect(sendsTo('C')).toHaveLength(0);
  });

  it('10-11. NACK from a peer retransmits only that peer; NACK from the wrong peer is isolated', async () => {
    const r = await renderHook();
    api = r.api;

    // A long transcript forces V7 fragmentation (>499-byte V6A packet).
    const longTextC = 'C'.repeat(1200);
    const longTextD = 'D'.repeat(1200);

    await enableVoice('C');
    sttResult(longTextC);
    await flush();

    setConnectionInfo({ state: 'CONNECTED', deviceId: 'D', mtu: 512 });
    sttResult(longTextD);
    await flush();

    // Both peers have fragmented messages in flight (all frames carry V7).
    const cSends = sendsTo('C');
    const dSends = sendsTo('D');
    expect(cSends.length).toBeGreaterThan(1);
    expect(dSends.length).toBeGreaterThan(1);
    const cFrag = v6bDecode(base64ToBytes(cSends[0]));
    const dFrag = v6bDecode(base64ToBytes(dSends[0]));
    expect(cFrag.payload[0]).toBe(V7_MARKER);
    expect(dFrag.payload[0]).toBe(V7_MARKER);
    const cGroupId = parseHeader(cFrag.payload).groupId;
    const dGroupId = parseHeader(dFrag.payload).groupId;

    clearSendCalls();

    // NACK about C's group arriving from D → routed to D's manager → no-op.
    act(() => {
      emitBLE('BLE_DATA_RECEIVED', { data: buildNackBase64(cGroupId), fromDevice: 'D' });
    });
    await flush();
    expect(sendsTo('C')).toHaveLength(0);
    expect(sendsTo('D')).toHaveLength(0);

    // NACK about D's group from D → D retransmits its own fragments.
    clearSendCalls();
    act(() => {
      emitBLE('BLE_DATA_RECEIVED', { data: buildNackBase64(dGroupId), fromDevice: 'D' });
    });
    await flush();
    const dRetries = decodeSendsTo('D');
    expect(dRetries.length).toBe(dSends.length); // all fragments resent
    expect(decodeSendsTo('C')).toHaveLength(0); // C unaffected

    // NACK about C's group from C → C retransmits its own fragments.
    clearSendCalls();
    act(() => {
      emitBLE('BLE_DATA_RECEIVED', { data: buildNackBase64(cGroupId), fromDevice: 'C' });
    });
    await flush();
    expect(decodeSendsTo('C').length).toBe(cSends.length);
    expect(decodeSendsTo('D')).toHaveLength(0); // D unaffected
  });

  it('12-13. retransmissions target the peer that owns the manager', async () => {
    const r = await renderHook();
    api = r.api;

    await enableVoice('C');
    sttResult('only to C');
    await flush();

    setConnectionInfo({ state: 'CONNECTED', deviceId: 'D', mtu: 512 });
    sttResult('only to D');
    await flush();
    clearSendCalls();

    await advance(2000);
    // Each retransmission must go to its own BLE peer and carry its own text.
    const cRet = decodeSendsTo('C');
    const dRet = decodeSendsTo('D');
    expect(cRet.length).toBe(1);
    expect(dRet.length).toBe(1);
    expect(textOfFrame(cRet[0].base64)).toBe('only to C');
    expect(textOfFrame(dRet[0].base64)).toBe('only to D');
  });

  it('14-15/12. per-peer active+queued messages stay isolated; ACK(C) promotes only C queued message', async () => {
    const r = await renderHook();
    api = r.api;

    await enableVoice('C');
    sttResult('C1');
    await flush();
    // C2 queues behind C1 (one active + one queued per manager).
    sttResult('C2');
    await flush();

    // Only C1's DATA frames were sent so far (C2 queued, not transmitted).
    let c1Frames = decodeSendsTo('C');
    expect(c1Frames.length).toBe(1);
    expect(textOfFrame(c1Frames[0].base64)).toBe('C1');

    // Meanwhile D has its own active+queued pair — D1 sends immediately.
    setConnectionInfo({ state: 'CONNECTED', deviceId: 'D', mtu: 512 });
    sttResult('D1');
    await flush();
    sttResult('D2');
    await flush();
    expect(decodeSendsTo('D').length).toBe(1);
    expect(textOfFrame(decodeSendsTo('D')[0].base64)).toBe('D1');

    // ACK C1 → C2 promotes and is transmitted to C only; D1 stays active.
    const c1MsgId = messageIdOfFrame(c1Frames[0].base64);
    clearSendCalls();
    act(() => {
      emitBLE('BLE_DATA_RECEIVED', { data: buildAckBase64(c1MsgId), fromDevice: 'C' });
    });
    await flush();

    const cPromoted = decodeSendsTo('C');
    expect(cPromoted.length).toBe(1);
    expect(textOfFrame(cPromoted[0].base64)).toBe('C2');
    expect(sendsTo('D')).toHaveLength(0); // D1 not promoted/affected

    // D1 still retransmits to D after its own timeout.
    clearSendCalls();
    await advance(2000);
    const dRet = decodeSendsTo('D');
    expect(dRet.length).toBe(1);
    expect(textOfFrame(dRet[0].base64)).toBe('D1');
  });

  it('15. ACK(D1) promotes D2 while C state is untouched', async () => {
    const r = await renderHook();
    api = r.api;

    await enableVoice('C');
    sttResult('C1');
    await flush();

    setConnectionInfo({ state: 'CONNECTED', deviceId: 'D', mtu: 512 });
    sttResult('D1');
    await flush();
    sttResult('D2');
    await flush();

    const d1MsgId = messageIdOfFrame(decodeSendsTo('D')[0].base64);
    clearSendCalls();
    act(() => {
      emitBLE('BLE_DATA_RECEIVED', { data: buildAckBase64(d1MsgId), fromDevice: 'D' });
    });
    await flush();

    // D2 promoted to D.
    const dPromoted = decodeSendsTo('D');
    expect(dPromoted.length).toBe(1);
    expect(textOfFrame(dPromoted[0].base64)).toBe('D2');
    // C1 still active — no C promotion happened, C gets no new frames.
    expect(sendsTo('C')).toHaveLength(0);
  });

  it('16-17/27. disconnect C removes only C reliability state; D continues', async () => {
    const r = await renderHook();
    api = r.api;

    await enableVoice('C');
    sttResult('C active');
    await flush();

    setConnectionInfo({ state: 'CONNECTED', deviceId: 'D', mtu: 512 });
    sttResult('D active');
    await flush();

    clearSendCalls();

    // C disconnects.
    act(() => {
      emitBLE('BLE_DISCONNECTED', { deviceId: 'C', reason: 'REMOTE' });
    });
    await flush();

    // C's manager was cancelled and removed → no further C sends.
    await advance(2000);
    await advance(2000);
    expect(sendsTo('C')).toHaveLength(0);

    // D's manager survives → D keeps retransmitting to D.
    const dFrames = decodeSendsTo('D');
    expect(dFrames.length).toBeGreaterThan(0);
    expect(textOfFrame(dFrames[0].base64)).toBe('D active');
  });

  it('18. reconnect C creates fresh per-peer state without affecting D', async () => {
    const r = await renderHook();
    api = r.api;

    await enableVoice('C');
    sttResult('C before');
    await flush();
    expect(decodeSendsTo('C')[0].sequence).toBe(0);

    setConnectionInfo({ state: 'CONNECTED', deviceId: 'D', mtu: 512 });
    sttResult('D before');
    await flush();
    expect(decodeSendsTo('D')[0].sequence).toBe(0);

    // C disconnects → its manager removed; D stays.
    act(() => {
      emitBLE('BLE_DISCONNECTED', { deviceId: 'C', reason: 'REMOTE' });
    });
    await flush();

    // Reconnect C (voice mode re-enabled targeting C).
    await enableVoice('C');
    sttResult('C after reconnect');
    await flush();

    // Fresh C manager → sequence restarts at 0 for the new session.
    const cAfter = decodeSendsTo('C');
    const cReconnect = cAfter[cAfter.length - 1];
    expect(cReconnect.sequence).toBe(0);
    expect(textOfFrame(cReconnect.base64)).toBe('C after reconnect');

    // D is unaffected — its pending message still retransmits to D.
    clearSendCalls();
    await advance(2000);
    const dRet = decodeSendsTo('D');
    expect(dRet.length).toBe(1);
    expect(textOfFrame(dRet[0].base64)).toBe('D before');
  });

  it('20. incoming DATA from C is ACKed to C and from D ACKed to D', async () => {
    const r = await renderHook();
    api = r.api;

    // No voice enable needed — the receive pipeline runs on BLE data events.
    const { v6a: v6aC } = semanticPayload('from peer C');
    act(() => {
      emitBLE('BLE_DATA_RECEIVED', {
        data: buildDataFrameBase64(v6aC, 0),
        fromDevice: 'C',
      });
    });
    await flush();

    // An ACK went back to C (not a no-device legacy send).
    const cAcks = decodeSendsTo('C').filter((f) => f.frameType === V6B_FRAME_ACK);
    expect(cAcks.length).toBe(1);

    const { v6a: v6aD } = semanticPayload('from peer D');
    act(() => {
      emitBLE('BLE_DATA_RECEIVED', {
        data: buildDataFrameBase64(v6aD, 0),
        fromDevice: 'D',
      });
    });
    await flush();

    const dAcks = decodeSendsTo('D').filter((f) => f.frameType === V6B_FRAME_ACK);
    expect(dAcks.length).toBe(1);
  });

  it('25. outbound sends always carry the target deviceId (never legacy no-peer)', async () => {
    const r = await renderHook();
    api = r.api;

    await enableVoice('C');
    sttResult('targeted');
    await flush();

    // Every send call must include the peer deviceId as the 2nd argument.
    const calls: any[] = mockNativeBLE.send.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call[1]).toBe('C');
    }
  });

  it('acknowledges that manager/seq instances are distinct via per-peer stream behavior', async () => {
    // Guards against a regression where both peers would share one
    // SequenceManager: streams must advance independently. Here C uses
    // seqs 0,1,2… and D starts at 0 at the same wall-clock time.
    const r = await renderHook();
    api = r.api;

    await enableVoice('C');
    sttResult('stream C');
    await flush();

    setConnectionInfo({ state: 'CONNECTED', deviceId: 'D', mtu: 512 });
    sttResult('stream D');
    await flush();

    expect(decodeSendsTo('C')[0].sequence).toBe(0);
    expect(decodeSendsTo('D')[0].sequence).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
// V9E Step 7 — BITCHAT peer-targeted transport through the hook
// ══════════════════════════════════════════════════════════════════
//
// These tests let the BITCHAT adapter initialize (storage mode 'resolve')
// and register DIRECT BLE peers through the ANNOUNCE exchange, then verify
// that STT voice messages originate through the mesh and that every hop
// transmission is a peer-targeted V6B_FRAME_BITCHAT frame delivered via
// NativeBLE.send(frame, peerBleId).

describe('useBLEVoiceMode — Step 7 BITCHAT peer-targeted transport', () => {
  const NODE_X = '0x00000000000000aa'; // direct peer behind BLE peer "C"
  const NODE_Y = '0x00000000000000bb'; // direct peer behind BLE peer "D"

  /** Flush the async adapter/announce/send chains (several microtask turns). */
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      await act(async () => {});
    }
  };

  /** Produce a remote node's raw ANNOUNCE envelope (as its adapter would). */
  const makeAnnounceBytes = (nodeId: string): Uint8Array => {
    const remote = new BitChatBLEAdapter({
      localNodeId: nodeId,
      bleSend: async () => {},
      onLocalDeliver: () => {},
    });
    return remote.createAnnouncePacket();
  };

  /** Wrap raw BITCHAT bytes in a V6B_FRAME_BITCHAT frame and base64 it. */
  const wrapV6BBitchat = (payload: Uint8Array, seq: number = 0): string => {
    const frame = v6bEncode(seq, V6B_FRAME_BITCHAT, payload);
    return bytesToBase64(frame);
  };

  /** Encode a BITCHAT DATA envelope with the given fields. */
  const dataEnvelope = (opts: {
    sourceNodeId: string;
    destinationNodeId: string;
    packetId: bigint;
    ttl: number;
    payload: Uint8Array;
  }): Uint8Array => {
    const packet: BitChatPacket = {
      version: 0x01,
      packetType: PACKET_TYPE_DATA,
      ttl: opts.ttl,
      sourceNodeId: opts.sourceNodeId,
      destinationNodeId: opts.destinationNodeId,
      packetId: normalizePacketId(opts.packetId),
      flags: FLAGS_NONE,
      payload: opts.payload,
    };
    return bitChatEncode(packet);
  };

  /** Have a BLE peer deliver its direct ANNOUNCE to this node (registers it). */
  const registerRemotePeer = async (blePeerId: string, remoteNodeId: string) => {
    act(() => {
      emitBLE('BLE_DATA_RECEIVED', {
        data: wrapV6BBitchat(makeAnnounceBytes(remoteNodeId), 0),
        fromDevice: blePeerId,
      });
    });
    await settle();
  };

  /**
   * V9E Step 9: a BLE peer connection triggers our direct ANNOUNCE to that
   * peer (connection-scoped, independent of voice mode). Emit the native
   * BLE_CONNECTED event so the announce is sent.
   */
  const announceToConnectedPeer = async (blePeerId: string, mtu: number = 512) => {
    act(() => {
      emitBLE('BLE_CONNECTED', { deviceId: blePeerId, mtu });
    });
    await settle();
  };

  /** Decode a captured send as a V6B frame and its BITCHAT envelope. */
  const decodeBitchatFrame = (base64: string) => {
    const frame = v6bDecode(base64ToBytes(base64));
    expect(frame.frameType).toBe(V6B_FRAME_BITCHAT);
    const envelope = bitChatDecode(frame.payload);
    return { frame, envelope };
  };

  const ttsSpeakMock = () => (rnMock.NativeModules.NativeTTS.speak as jest.Mock);

  it('REAL PRODUCTION COMPOSITION: ChatScreen sends through the mounted hook binding, adapter, V6B, and NativeBLE boundary', async () => {
    setStorageMode('resolve');
    setStorageMap({ bitchat_node_id: '0x00000000000000a1' });
    const mounted = await renderChatWithProductionHook();
    api = mounted.api;

    await announceToConnectedPeer('C');
    await registerRemotePeer('C', NODE_X);
    clearSendCalls();

    // This can become true only when the mounted production hook has bound
    // ChatMessageService to its adapter and the native ANNOUNCE path has
    // registered NODE_X behind BLE peer C. The test never injects either.
    expect(isChatTransportReady(NODE_X)).toBe(true);
    expect(mounted.renderer.root.findByProps({ testID: `chat-peer-${NODE_X}` })).toBeTruthy();
    await act(async () => {
      mounted.renderer.root.findByProps({ testID: `chat-peer-${NODE_X}` }).props.onPress();
    });
    const text = 'production-bound fragmented chat '.repeat(30).trim();
    await act(async () => {
      mounted.renderer.root.findByProps({ testID: 'chat-input' }).props.onChangeText(text);
    });
    await act(async () => {
      await mounted.renderer.root.findByProps({ testID: 'chat-send' }).props.onPress();
    });

    expect(mockNativeBLE.send.mock.calls.length).toBeGreaterThan(1);
    expect(mockNativeBLE.send.mock.calls).toEqual(expect.arrayContaining([
      [expect.any(String), 'C', expect.any(String)],
    ]));
    const chatPayloads = mockNativeBLE.send.mock.calls.map(([base64]: [string]) => {
      const { envelope } = decodeBitchatFrame(base64);
      expect(envelope).toEqual(expect.objectContaining({
        sourceNodeId: '0x00000000000000a1',
        destinationNodeId: NODE_X,
        packetType: PACKET_TYPE_DATA,
      }));
      const chatPayload = decodeChatApplicationPayload(envelope.payload);
      expect(chatPayload).not.toBeNull();
      expect(chatPayload![0]).toBe(V7_MARKER);
      return chatPayload!;
    });
    const orderedPayloads = [...chatPayloads].sort((left, right) => (
      parseHeader(left).fragmentIndex - parseHeader(right).fragmentIndex
    ));
    const firstHeader = parseHeader(orderedPayloads[0]);
    expect(orderedPayloads.map(payload => parseHeader(payload).fragmentIndex))
      .toEqual(Array.from({ length: firstHeader.totalFragments }, (_, index) => index));
    const v6a = new Uint8Array(firstHeader.v6aLength);
    let offset = 0;
    for (const payload of orderedPayloads) {
      const body = payload.slice(V7_HEADER_SIZE);
      v6a.set(body, offset);
      offset += body.length;
    }
    expect(offset).toBe(firstHeader.v6aLength);
    expect(decodeWithFallback(v6a)).toEqual(expect.objectContaining({ text }));
    expect(getChatSnapshot().messages).toEqual([
      expect.objectContaining({ status: 'SENT', recipientNodeId: NODE_X, text }),
    ]);

    await act(async () => { mounted.renderer.unmount(); });
  });

  it('REAL PRODUCTION COMPOSITION: a NativeBLE rejection becomes FAILED and is rendered by ChatScreen', async () => {
    setStorageMode('resolve');
    setStorageMap({ bitchat_node_id: '0x00000000000000a1' });
    const mounted = await renderChatWithProductionHook();
    api = mounted.api;

    await announceToConnectedPeer('C');
    await registerRemotePeer('C', NODE_X);
    clearSendCalls();
    mockNativeBLE.send.mockRejectedValueOnce(new Error('WRITE_FAILED'));

    await act(async () => {
      mounted.renderer.root.findByProps({ testID: `chat-peer-${NODE_X}` }).props.onPress();
    });
    await act(async () => {
      mounted.renderer.root.findByProps({ testID: 'chat-input' }).props.onChangeText('must fail visibly');
    });
    await act(async () => {
      await mounted.renderer.root.findByProps({ testID: 'chat-send' }).props.onPress();
    });

    expect(mockNativeBLE.send).toHaveBeenCalledTimes(1);
    expect(getChatSnapshot().messages).toEqual([
      expect.objectContaining({ status: 'FAILED', text: 'must fail visibly' }),
    ]);
    expect(mounted.renderer.root.findAllByProps({ children: 'No mesh peer accepted the message' }).length).toBeGreaterThan(0);
    expect(getChatSnapshot().messages[0].status).not.toBe('SENT');

    await act(async () => { mounted.renderer.unmount(); });
  });

  it('1-3/21-22. ANNOUNCE registers the peer; mesh originate sends exactly one peer-targeted BITCHAT frame', async () => {
    setStorageMode('resolve');
    const r = await renderHook();
    api = r.api;

    await announceToConnectedPeer('C');
    await enableVoice('C');
    await settle();

    // The C connection must have sent a V6B-wrapped ANNOUNCE targeted at C.
    const announceFrames = decodeSendsTo('C');
    expect(announceFrames.length).toBe(1);
    expect(announceFrames[0].frameType).toBe(V6B_FRAME_BITCHAT);
    const announceEnvelope = bitChatDecode(
      v6bDecode(base64ToBytes(announceFrames[0].base64)).payload,
    );
    expect(announceEnvelope.packetType).toBe(PACKET_TYPE_ANNOUNCE);
    const ourNodeId = announceEnvelope.sourceNodeId;
    expect(ourNodeId).toMatch(/^0x[0-9a-f]{16}$/);

    // Remote peer C announces itself → direct mapping registered.
    await registerRemotePeer('C', NODE_X);

    // Speak one message: mesh path (adapter present) → BITCHAT originate.
    clearSendCalls();
    sttResult('mesh hello');
    await settle();

    const cFrames = decodeSendsTo('C');
    // Exactly ONE logical application transmission to C (no duplicate first-hop send).
    expect(cFrames.length).toBe(1);
    const { envelope } = decodeBitchatFrame(cFrames[0].base64);
    expect(envelope.packetType).toBe(PACKET_TYPE_DATA);
    expect(envelope.sourceNodeId).toBe(ourNodeId);
    expect(envelope.destinationNodeId).toBe(NODE_ID_BROADCAST);
    expect(envelope.ttl).toBe(DEFAULT_TTL - 1); // forwarded copy decremented once
    // The BITCHAT payload is the original V6A bytes (text decodes).
    const semantic = decodeWithFallback(envelope.payload);
    expect(semantic).not.toBeNull();
    expect(semantic!.text).toBe('mesh hello');

    // Every BITCHAT transmission was peer-targeted — no legacy no-device send.
    for (const call of mockNativeBLE.send.mock.calls) {
      expect(call[1]).toBe('C');
    }
    // No legacy single-arg (untargeted) sends occurred for BITCHAT traffic.
    const untargeted = mockNativeBLE.send.mock.calls.filter((c: any[]) => c.length < 2);
    expect(untargeted).toHaveLength(0);
  });

  it('5-8/23. fan-out to C and D uses independent V8 sequence streams and both targets', async () => {
    setStorageMode('resolve');
    const r = await renderHook();
    api = r.api;

    await announceToConnectedPeer('C');
    await announceToConnectedPeer('D');
    await enableVoice('C');
    await settle();

    await registerRemotePeer('C', NODE_X);
    await registerRemotePeer('D', NODE_Y);

    clearSendCalls();
    sttResult('fan out to mesh');
    await settle();

    // Both direct BLE peers receive one BITCHAT DATA frame.
    const cFrames = decodeSendsTo('C');
    const dFrames = decodeSendsTo('D');
    expect(cFrames.length).toBe(1);
    expect(dFrames.length).toBe(1);
    expect(cFrames[0].frameType).toBe(V6B_FRAME_BITCHAT);
    expect(dFrames[0].frameType).toBe(V6B_FRAME_BITCHAT);

    // Independent sequence streams: both peers consumed seq 0 for their own
    // ANNOUNCE (sent on connection), so each DATA frame is seq 1 — the
    // streams advance independently per peer.
    expect(cFrames[0].sequence).toBe(1);
    expect(dFrames[0].sequence).toBe(1);

    // Same BITCHAT identity on both peers (same logical message).
    const cEnv = decodeBitchatFrame(cFrames[0].base64).envelope;
    const dEnv = decodeBitchatFrame(dFrames[0].base64).envelope;
    expect(cEnv.packetId).toBe(dEnv.packetId);
    expect(cEnv.sourceNodeId).toBe(dEnv.sourceNodeId);
    expect(cEnv.ttl).toBe(DEFAULT_TTL - 1);
    expect(dEnv.ttl).toBe(DEFAULT_TTL - 1);
  });

  it('REAL APPLICATION INTEGRATION: typed chat bypasses TTS while normal and fragmented voice retain TTS, including fragmented typed-chat reassembly', async () => {
    setStorageMode('resolve');
    const r = await renderHook();
    api = r.api;
    await announceToConnectedPeer('C');
    await enableVoice('C');
    await settle();
    const localNodeId = decodeBitchatFrame(decodeSendsTo('C')[0].base64).envelope.sourceNodeId;
    await registerRemotePeer('C', NODE_X);

    const deliver = async (packetId: bigint, payload: Uint8Array) => {
      act(() => {
        emitBLE('BLE_DATA_RECEIVED', {
          data: wrapV6BBitchat(dataEnvelope({
            sourceNodeId: NODE_X,
            destinationNodeId: localNodeId,
            packetId,
            ttl: DEFAULT_TTL,
            payload,
          }), 0),
          fromDevice: 'C',
        });
      });
      await settle();
    };

    // CASE A: typed-chat application envelope reaches the chat store but
    // returns before the existing voice decoder/TTS invocation.
    const typed = semanticPayload('typed chat does not speak');
    ttsSpeakMock().mockClear();
    await deliver(BigInt(7400), encodeChatApplicationPayload(typed.v6a));
    expect(ttsSpeakMock()).not.toHaveBeenCalled();
    expect(getChatSnapshot().messages).toEqual([
      expect.objectContaining({
        senderNodeId: NODE_X,
        recipientNodeId: localNodeId,
        text: 'typed chat does not speak',
      }),
    ]);

    // CASE B: an ordinary voice payload follows its established processing
    // path, reaches TTS, and creates no typed-chat bubble.
    const voice = semanticPayload('voice still speaks');
    await deliver(BigInt(7401), voice.v6a);
    expect(ttsSpeakMock()).toHaveBeenCalledWith('voice still speaks', 'en', false);
    expect(getChatSnapshot().messages).toHaveLength(1);

    // CASE C: out-of-order typed-chat V7 fragments are reassembled by the
    // chat application layer only.
    const fragmentedChat = semanticPayload('c'.repeat(1200));
    const chatFragments = splitV6AForBudget(
      fragmentedChat.v6a,
      V6B_MAX_PAYLOAD_SIZE - BITCHAT_HEADER_SIZE - 4,
    );
    expect(chatFragments.length).toBeGreaterThan(1);
    ttsSpeakMock().mockClear();
    for (const [index, fragment] of [...chatFragments].reverse().entries()) {
      await deliver(BigInt(7410 + index), encodeChatApplicationPayload(fragment.payload));
      if (index < chatFragments.length - 1) expect(getChatSnapshot().messages).toHaveLength(1);
    }
    expect(ttsSpeakMock()).not.toHaveBeenCalled();
    expect(getChatSnapshot().messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'c'.repeat(1200), status: 'RECEIVED' }),
    ]));

    // CASE D: raw V7 voice fragments remain owned by the pre-existing voice
    // reassembler and reach TTS, never becoming a chat record.
    const fragmentedVoice = semanticPayload('v'.repeat(1200));
    const voiceFragments = splitV6AForBudget(
      fragmentedVoice.v6a,
      V6B_MAX_PAYLOAD_SIZE - BITCHAT_HEADER_SIZE,
    );
    expect(voiceFragments.length).toBeGreaterThan(1);
    const chatCountBeforeVoice = getChatSnapshot().messages.length;
    ttsSpeakMock().mockClear();
    for (const [index, fragment] of voiceFragments.entries()) {
      await deliver(BigInt(7420 + index), fragment.payload);
    }
    expect(ttsSpeakMock()).toHaveBeenCalledWith('v'.repeat(1200), 'en', false);
    expect(getChatSnapshot().messages).toHaveLength(chatCountBeforeVoice);
  });

  it('relay: inbound broadcast DATA from C is delivered locally AND forwarded to D with targeting', async () => {
    setStorageMode('resolve');
    const r = await renderHook();
    api = r.api;

    await enableVoice('C');
    await settle();
    await registerRemotePeer('C', NODE_X);
    await registerRemotePeer('D', NODE_Y);

    const { v6a } = semanticPayload('relay through me');
    const envelopeBytes = dataEnvelope({
      sourceNodeId: NODE_X,
      destinationNodeId: NODE_ID_BROADCAST,
      packetId: BigInt(7100),
      ttl: DEFAULT_TTL,
      payload: v6a,
    });

    clearSendCalls();
    ttsSpeakMock().mockClear();
    act(() => {
      emitBLE('BLE_DATA_RECEIVED', {
        data: wrapV6BBitchat(envelopeBytes, 0),
        fromDevice: 'C',
      });
    });
    await settle();

    // Broadcast → locally delivered and spoken.
    expect(ttsSpeakMock()).toHaveBeenCalled();
    const spokenText = ttsSpeakMock().mock.calls[0][0];
    expect(spokenText).toBe('relay through me');

    // Forwarded only to D (never bounced back to C), peer-targeted.
    expect(sendsTo('C')).toHaveLength(0);
    const dFrames = decodeSendsTo('D');
    expect(dFrames.length).toBe(1);
    const { envelope } = decodeBitchatFrame(dFrames[0].base64);
    expect(envelope.sourceNodeId).toBe(NODE_X); // source preserved
    expect(envelope.packetId).toBe(normalizePacketId(BigInt(7100))); // identity preserved
    expect(envelope.destinationNodeId).toBe(NODE_ID_BROADCAST);
    expect(envelope.ttl).toBe(DEFAULT_TTL - 1); // decremented exactly once
  });

  it('relay-only: unicast addressed to D is forwarded but NOT spoken locally', async () => {
    setStorageMode('resolve');
    const r = await renderHook();
    api = r.api;

    await enableVoice('C');
    await settle();
    await registerRemotePeer('C', NODE_X);
    await registerRemotePeer('D', NODE_Y);

    const { v6a } = semanticPayload('do not speak this at the relay');
    const envelopeBytes = dataEnvelope({
      sourceNodeId: NODE_X,
      destinationNodeId: NODE_Y, // unicast to the peer behind D
      packetId: BigInt(7200),
      ttl: DEFAULT_TTL,
      payload: v6a,
    });

    clearSendCalls();
    ttsSpeakMock().mockClear();
    act(() => {
      emitBLE('BLE_DATA_RECEIVED', {
        data: wrapV6BBitchat(envelopeBytes, 0),
        fromDevice: 'C',
      });
    });
    await settle();

    // Relay node must NOT speak transit traffic.
    expect(ttsSpeakMock()).not.toHaveBeenCalled();

    // Forwarded to D only.
    expect(sendsTo('C')).toHaveLength(0);
    const dFrames = decodeSendsTo('D');
    expect(dFrames.length).toBe(1);
    const { envelope } = decodeBitchatFrame(dFrames[0].base64);
    expect(envelope.destinationNodeId).toBe(NODE_Y);
    expect(envelope.sourceNodeId).toBe(NODE_X);
    expect(envelope.packetId).toBe(normalizePacketId(BigInt(7200)));
  });

  it('18. disconnect removes the peer from usable relay targets', async () => {
    setStorageMode('resolve');
    const r = await renderHook();
    api = r.api;

    await enableVoice('C');
    await settle();
    await registerRemotePeer('C', NODE_X);
    await registerRemotePeer('D', NODE_Y);

    const deliverBroadcast = async (packetId: bigint, text: string) => {
      const { v6a } = semanticPayload(text);
      const envelopeBytes = dataEnvelope({
        sourceNodeId: NODE_X,
        destinationNodeId: NODE_ID_BROADCAST,
        packetId,
        ttl: DEFAULT_TTL,
        payload: v6a,
      });
      act(() => {
        emitBLE('BLE_DATA_RECEIVED', {
          data: wrapV6BBitchat(envelopeBytes, 0),
          fromDevice: 'C',
        });
      });
      await settle();
    };

    clearSendCalls();
    await deliverBroadcast(BigInt(7300), 'first broadcast');
    // While D is connected it receives the relayed frame.
    expect(decodeSendsTo('D').length).toBe(1);

    // D disconnects → adapter unregisters D (relay target removed).
    act(() => {
      emitBLE('BLE_DISCONNECTED', { deviceId: 'D', reason: 'REMOTE' });
    });
    await settle();

    clearSendCalls();
    await deliverBroadcast(BigInt(7301), 'second broadcast');
    // No relay attempt to the disconnected D peer.
    expect(sendsTo('D')).toHaveLength(0);
    expect(sendsTo('C')).toHaveLength(0); // C excluded as incoming peer
  });
});
// ══════════════════════════════════════════════════════════════════
// V9E Step 9 — relay/voice lifecycle separation
// ══════════════════════════════════════════════════════════════════
//
// These tests prove the BITCHAT mesh/relay lifecycle is independent of
// voice mode: the adapter initializes on mount (not on voice enable), relay
// forwarding works with voice mode OFF, voice stop does not unregister mesh
// peers, per-peer disconnect cleanup is isolated, and relay/control traffic
// never reaches TTS.
describe('useBLEVoiceMode — Step 9 relay/voice lifecycle separation', () => {
  const NODE_X = '0x00000000000000aa'; // direct peer behind BLE peer "C"
  const NODE_Y = '0x00000000000000bb'; // direct peer behind BLE peer "D"

  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      await act(async () => {});
    }
  };

  const makeAnnounceBytes = (nodeId: string): Uint8Array => {
    const remote = new BitChatBLEAdapter({
      localNodeId: nodeId,
      bleSend: async () => {},
      onLocalDeliver: () => {},
    });
    return remote.createAnnouncePacket();
  };

  const wrapV6BBitchat = (payload: Uint8Array, seq: number = 0): string => {
    const frame = v6bEncode(seq, V6B_FRAME_BITCHAT, payload);
    return bytesToBase64(frame);
  };

  const registerRemotePeer = async (blePeerId: string, remoteNodeId: string) => {
    act(() => {
      emitBLE('BLE_DATA_RECEIVED', {
        data: wrapV6BBitchat(makeAnnounceBytes(remoteNodeId), 0),
        fromDevice: blePeerId,
      });
    });
    await settle();
  };

  /** Deliver an inbound BITCHAT DATA envelope from a BLE peer. */
  const deliverData = async (fromPeer: string, envelopeBytes: Uint8Array) => {
    act(() => {
      emitBLE('BLE_DATA_RECEIVED', {
        data: wrapV6BBitchat(envelopeBytes, 0),
        fromDevice: fromPeer,
      });
    });
    await settle();
  };

  const dataEnvelope = (opts: {
    sourceNodeId: string;
    destinationNodeId: string;
    packetId: bigint;
    ttl: number;
    payload: Uint8Array;
  }): Uint8Array => {
    const packet: BitChatPacket = {
      version: 0x01,
      packetType: PACKET_TYPE_DATA,
      ttl: opts.ttl,
      sourceNodeId: opts.sourceNodeId,
      destinationNodeId: opts.destinationNodeId,
      packetId: normalizePacketId(opts.packetId),
      flags: FLAGS_NONE,
      payload: opts.payload,
    };
    return bitChatEncode(packet);
  };

  const ttsSpeakMock = () => (rnMock.NativeModules.NativeTTS.speak as jest.Mock);

  it('1. adapter initializes on mount without voice mode (announce on peer connect)', async () => {
    setStorageMode('resolve');
    const r = await renderHook();
    api = r.api;
    await settle();

    // No peers connected yet → nothing sent (voice mode is OFF).
    expect(mockNativeBLE.send).not.toHaveBeenCalled();
    expect(api().enabled).toBe(false);

    // A peer connection announces even with voice mode OFF.
    clearSendCalls();
    act(() => {
      emitBLE('BLE_CONNECTED', { deviceId: 'C', mtu: 512 });
    });
    await settle();

    const cFrames = decodeSendsTo('C');
    expect(cFrames.length).toBe(1);
    expect(cFrames[0].frameType).toBe(V6B_FRAME_BITCHAT);
    const env = bitChatDecode(v6bDecode(base64ToBytes(cFrames[0].base64)).payload);
    expect(env.packetType).toBe(PACKET_TYPE_ANNOUNCE);
  });

  it('2/5. relay forwarding works with voice mode OFF and survives voice stop', async () => {
    setStorageMode('resolve');
    const r = await renderHook();
    api = r.api;
    await settle();

    // Voice mode is never enabled in this test.
    await registerRemotePeer('C', NODE_X);
    await registerRemotePeer('D', NODE_Y);

    const { v6a } = semanticPayload('relay while voice is off');
    const envelopeBytes = dataEnvelope({
      sourceNodeId: NODE_X,
      destinationNodeId: NODE_Y, // unicast to D — not local
      packetId: BigInt(9001),
      ttl: DEFAULT_TTL,
      payload: v6a,
    });

    clearSendCalls();
    ttsSpeakMock().mockClear();
    await deliverData('C', envelopeBytes);

    // Forwarded to D (peer-targeted), NOT spoken locally.
    const dFrames = decodeSendsTo('D');
    expect(dFrames.length).toBe(1);
    expect(dFrames[0].frameType).toBe(V6B_FRAME_BITCHAT);
    expect(ttsSpeakMock()).not.toHaveBeenCalled();
    expect(api().enabled).toBe(false);

    // Enabling then stopping voice mode must NOT tear down relay state.
    await enableVoice('C');
    await act(async () => {
      await api().toggleVoiceMode();
    });
    await settle();
    expect(api().enabled).toBe(false);

    // Relay still works after voice stop (fresh packet identity — dedup
    // must not mask the lifecycle behavior being tested).
    const envelope2 = dataEnvelope({
      sourceNodeId: NODE_X,
      destinationNodeId: NODE_Y,
      packetId: BigInt(9006),
      ttl: DEFAULT_TTL,
      payload: v6a,
    });
    clearSendCalls();
    await deliverData('C', envelope2);
    expect(decodeSendsTo('D').length).toBe(1);
    expect(ttsSpeakMock()).not.toHaveBeenCalled();
  });

  it('3/4. peer disconnect cleanup is isolated — D disconnect leaves C relaying', async () => {
    setStorageMode('resolve');
    const r = await renderHook();
    api = r.api;
    await settle();

    await registerRemotePeer('C', NODE_X);
    await registerRemotePeer('D', NODE_Y);

    // D disconnects → only D's mapping/state is removed.
    act(() => {
      emitBLE('BLE_DISCONNECTED', { deviceId: 'D', reason: 'REMOTE' });
    });
    await settle();

    // C can still relay: a unicast from C to a third node is processed
    // (forwarded where possible), never spoken locally.
    const { v6a } = semanticPayload('after D left');
    const unicast = dataEnvelope({
      sourceNodeId: NODE_X,
      destinationNodeId: '0x00000000000000cc', // some third node
      packetId: BigInt(9002),
      ttl: DEFAULT_TTL,
      payload: v6a,
    });
    clearSendCalls();
    ttsSpeakMock().mockClear();
    await deliverData('C', unicast);
    expect(ttsSpeakMock()).not.toHaveBeenCalled();

    // Reconnect D on the same BLE device → ANNOUNCE is sent again
    // (connection-scoped) and D can be relayed to again.
    clearSendCalls();
    act(() => {
      emitBLE('BLE_CONNECTED', { deviceId: 'D', mtu: 512 });
    });
    await settle();
    const dAnnounce = decodeSendsTo('D');
    expect(dAnnounce.length).toBe(1);
    expect(dAnnounce[0].frameType).toBe(V6B_FRAME_BITCHAT);
    expect(
      bitChatDecode(v6bDecode(base64ToBytes(dAnnounce[0].base64)).payload).packetType,
    ).toBe(PACKET_TYPE_ANNOUNCE);

    // D re-registers and can relay again (fresh packet identity).
    await registerRemotePeer('D', NODE_Y);
    const freshUnicast = dataEnvelope({
      sourceNodeId: NODE_X,
      destinationNodeId: '0x00000000000000cc',
      packetId: BigInt(9007),
      ttl: DEFAULT_TTL,
      payload: v6a,
    });
    clearSendCalls();
    await deliverData('C', freshUnicast);
    const dFrames = decodeSendsTo('D');
    expect(dFrames.length).toBe(1);
    expect(dFrames[0].frameType).toBe(V6B_FRAME_BITCHAT);
  });
  it('6/8. relay and control traffic never reach TTS; discovery stays out of voice', async () => {
    setStorageMode('resolve');
    const r = await renderHook();
    api = r.api;
    await settle();

    await registerRemotePeer('C', NODE_X);
    await registerRemotePeer('D', NODE_Y);

    // 6: relay-only unicast addressed elsewhere is NOT spoken.
    const { v6a } = semanticPayload('not for this node');
    const unicast = dataEnvelope({
      sourceNodeId: NODE_X,
      destinationNodeId: NODE_Y,
      packetId: BigInt(9003),
      ttl: DEFAULT_TTL,
      payload: v6a,
    });
    ttsSpeakMock().mockClear();
    await deliverData('C', unicast);
    expect(ttsSpeakMock()).not.toHaveBeenCalled();

    // 8: a DISCOVERY packet is control traffic — recorded + flooded, never spoken.
    const discoveryPacket: BitChatPacket = {
      version: 0x01,
      packetType: PACKET_TYPE_DISCOVERY,
      ttl: DEFAULT_TTL,
      sourceNodeId: NODE_X,
      destinationNodeId: NODE_ID_BROADCAST,
      packetId: normalizePacketId(BigInt(9004)),
      flags: FLAGS_NONE,
      payload: encodeDiscovery(NODE_X),
    };
    ttsSpeakMock().mockClear();
    clearSendCalls();
    await deliverData('C', bitChatEncode(discoveryPacket));
    expect(ttsSpeakMock()).not.toHaveBeenCalled();
    // Discovery is flooded onward to the other eligible peer (D).
    const dFrames = decodeSendsTo('D');
    expect(dFrames.length).toBe(1);
    const env = bitChatDecode(v6bDecode(base64ToBytes(dFrames[0].base64)).payload);
    expect(env.packetType).toBe(PACKET_TYPE_DISCOVERY);
  });

  it('7. local-addressed voice payload still reaches voice delivery', async () => {
    setStorageMode('resolve');
    const r = await renderHook();
    api = r.api;
    await settle();

    await registerRemotePeer('C', NODE_X);
    await enableVoice('C');

    // Broadcast (addresses every node, including local) → delivered + spoken.
    const { v6a } = semanticPayload('speak this one');
    const broadcast = dataEnvelope({
      sourceNodeId: NODE_X,
      destinationNodeId: NODE_ID_BROADCAST,
      packetId: BigInt(9005),
      ttl: DEFAULT_TTL,
      payload: v6a,
    });
    ttsSpeakMock().mockClear();
    await deliverData('C', broadcast);
    expect(ttsSpeakMock()).toHaveBeenCalledTimes(1);
    expect(ttsSpeakMock().mock.calls[0][0]).toBe('speak this one');
  });

  it('9. component unmount does not globally destroy mesh state used by the app', async () => {
    setStorageMode('resolve');
    const r = await renderHook();
    api = r.api;
    await settle();

    await registerRemotePeer('C', NODE_X);

    // Unmount the hook (e.g. leaving the screen). The hook's own
    // subscriptions are removed; assert unmount is clean and no further
    // BLE traffic is processed afterwards.
    await act(async () => {
      r.renderer.unmount();
    });
    const callsAfter = mockNativeBLE.send.mock.calls.length;
    act(() => {
      emitBLE('BLE_DATA_RECEIVED', {
        data: wrapV6BBitchat(makeAnnounceBytes(NODE_Y), 0),
        fromDevice: 'D',
      });
    });
    await settle();
    expect(mockNativeBLE.send.mock.calls.length).toBe(callsAfter);
  });

  it('10. existing single-peer voice behavior remains intact', async () => {
    setStorageMode('hang'); // direct V6B path, no adapter
    const r = await renderHook();
    api = r.api;

    await enableVoice('C');
    sttResult('plain single peer');
    await flush();

    const cFrames = decodeSendsTo('C');
    expect(cFrames.length).toBe(1);
    expect(cFrames[0].frameType).toBe(V6B_FRAME_V6A_MESSAGE);
    expect(textOfFrame(cFrames[0].base64)).toBe('plain single peer');
  });

  it('11. multi-peer voice sends remain independent', async () => {
    setStorageMode('resolve');
    const r = await renderHook();
    api = r.api;
    await settle();

    // Connect C and D (each connection triggers our ANNOUNCE to that peer).
    act(() => {
      emitBLE('BLE_CONNECTED', { deviceId: 'C', mtu: 512 });
    });
    act(() => {
      emitBLE('BLE_CONNECTED', { deviceId: 'D', mtu: 512 });
    });
    await settle();
    await enableVoice('C');
    await settle();
    await registerRemotePeer('C', NODE_X);
    await registerRemotePeer('D', NODE_Y);

    // Two voice messages (mesh broadcast fans out to both connected peers).
    clearSendCalls();
    setConnectionInfo({ state: 'CONNECTED', deviceId: 'C', mtu: 512 });
    sttResult('voice to C');
    await settle();
    sttResult('voice to D');
    await settle();

    const cFrames = decodeSendsTo('C');
    const dFrames = decodeSendsTo('D');
    expect(cFrames.length).toBe(2);
    expect(dFrames.length).toBe(2);
    expect(cFrames.every((f) => f.frameType === V6B_FRAME_BITCHAT)).toBe(true);
    expect(dFrames.every((f) => f.frameType === V6B_FRAME_BITCHAT)).toBe(true);
    // Each peer's stream advanced independently: seq 0 = its ANNOUNCE,
    // seq 1/2 = the two DATA fan-out transmissions.
    expect(cFrames.map((f) => f.sequence)).toEqual([1, 2]);
    expect(dFrames.map((f) => f.sequence)).toEqual([1, 2]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// V9E Step 10 — destination-aware voice routing
//
// Voice origination must be explicitly destination-aware (BITCHAT nodeId),
// never a legacy "primary connected peer" (Bluetooth deviceId). These tests
// drive the real hook + adapter/RelayEngine through the controllable native
// fakes and assert on the decoded BITCHAT envelopes.
describe('useBLEVoiceMode — Step 10 destination-aware voice routing', () => {
  const NODE_X = '0x00000000000000aa'; // direct peer behind BLE peer "C"
  const NODE_Y = '0x00000000000000bb'; // direct peer behind BLE peer "D"
  const NODE_Z = '0x00000000000000cc'; // multi-hop node (not directly connected)

  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      await act(async () => {});
    }
  };

  const makeAnnounceBytes = (nodeId: string): Uint8Array => {
    const remote = new BitChatBLEAdapter({
      localNodeId: nodeId,
      bleSend: async () => {},
      onLocalDeliver: () => {},
    });
    return remote.createAnnouncePacket();
  };

  const wrapV6BBitchat = (payload: Uint8Array, seq: number = 0): string => {
    const frame = v6bEncode(seq, V6B_FRAME_BITCHAT, payload);
    return bytesToBase64(frame);
  };

  const registerRemotePeer = async (blePeerId: string, remoteNodeId: string) => {
    act(() => {
      emitBLE('BLE_DATA_RECEIVED', {
        data: wrapV6BBitchat(makeAnnounceBytes(remoteNodeId), 0),
        fromDevice: blePeerId,
      });
    });
    await settle();
  };

  const announceToConnectedPeer = async (blePeerId: string, mtu: number = 512) => {
    act(() => {
      emitBLE('BLE_CONNECTED', { deviceId: blePeerId, mtu });
    });
    await settle();
  };

  const decodeBitchatFrame = (base64: string) => {
    const frame = v6bDecode(base64ToBytes(base64));
    expect(frame.frameType).toBe(V6B_FRAME_BITCHAT);
    const envelope = bitChatDecode(frame.payload);
    return { frame, envelope };
  };

  /** Deliver an inbound BITCHAT DATA envelope from a BLE peer. */
  const deliverData = async (fromPeer: string, envelopeBytes: Uint8Array) => {
    act(() => {
      emitBLE('BLE_DATA_RECEIVED', {
        data: wrapV6BBitchat(envelopeBytes, 0),
        fromDevice: fromPeer,
      });
    });
    await settle();
  };

  const dataEnvelope = (opts: {
    sourceNodeId: string;
    destinationNodeId: string;
    packetId: bigint;
    ttl: number;
    payload: Uint8Array;
  }): Uint8Array => {
    const packet: BitChatPacket = {
      version: 0x01,
      packetType: PACKET_TYPE_DATA,
      ttl: opts.ttl,
      sourceNodeId: opts.sourceNodeId,
      destinationNodeId: opts.destinationNodeId,
      packetId: normalizePacketId(opts.packetId),
      flags: FLAGS_NONE,
      payload: opts.payload,
    };
    return bitChatEncode(packet);
  };

  const ttsSpeakMock = () => (rnMock.NativeModules.NativeTTS.speak as jest.Mock);

  beforeEach(() => {
    resetVoiceDestinationStore();
  });

  it('A. voice send does not call getConnectionState() to select the destination', async () => {
    setStorageMode('resolve');
    const r = await renderHook();
    api = r.api;

    await announceToConnectedPeer('C');
    await enableVoice('C');
    await registerRemotePeer('C', NODE_X);

    clearSendCalls();
    mockNativeBLE.getConnectionState.mockClear();

    sttResult('hello without primary peer');
    await settle();

    // A frame was sent to the BLE peer — but selection came from BITCHAT
    // routing, not from a legacy connection-state lookup.
    const frames = decodeSendsTo('C');
    expect(frames.length).toBe(1);
    expect(mockNativeBLE.getConnectionState).not.toHaveBeenCalled();

    // Default destination is explicit broadcast.
    const { envelope } = decodeBitchatFrame(frames[0].base64);
    expect(envelope.destinationNodeId).toBe(NODE_ID_BROADCAST);
  });

  it('B/C. selected nodeId is encoded as destinationNodeId, distinct from BLE deviceId', async () => {
    setStorageMode('resolve');
    const r = await renderHook();
    api = r.api;

    await announceToConnectedPeer('C');
    await enableVoice('C');
    await registerRemotePeer('C', NODE_X);

    setVoiceDestinationNodeId(NODE_X);
    clearSendCalls();
    sttResult('to node x');
    await settle();

    const frames = decodeSendsTo('C');
    expect(frames.length).toBe(1);
    const { envelope } = decodeBitchatFrame(frames[0].base64);
    // The BITCHAT destination is the nodeId — never the BLE deviceId.
    expect(envelope.destinationNodeId).toBe(NODE_X);
    expect(NODE_X).not.toBe('C');
  });

  it('D. directly connected destination still routes through its BLE peer', async () => {
    setStorageMode('resolve');
    const r = await renderHook();
    api = r.api;

    await announceToConnectedPeer('C');
    await announceToConnectedPeer('D');
    await enableVoice('C');
    await registerRemotePeer('C', NODE_X);
    await registerRemotePeer('D', NODE_Y);

    // Destination NODE_X is directly behind BLE peer C.
    setVoiceDestinationNodeId(NODE_X);
    clearSendCalls();
    sttResult('direct to x');
    await settle();

    // MeshRouter floods to all eligible peers (no routing table); every
    // frame carries the correct logical destination and targets a peer.
    const cFrames = decodeSendsTo('C');
    const dFrames = decodeSendsTo('D');
    expect(cFrames.length).toBe(1);
    expect(dFrames.length).toBe(1);
    expect(decodeBitchatFrame(cFrames[0].base64).envelope.destinationNodeId).toBe(NODE_X);
    expect(decodeBitchatFrame(dFrames[0].base64).envelope.destinationNodeId).toBe(NODE_X);
  });

  it('E. multi-hop destination (no direct mapping) remains relayable', async () => {
    setStorageMode('resolve');
    const r = await renderHook();
    api = r.api;

    await announceToConnectedPeer('C');
    await enableVoice('C');
    await registerRemotePeer('C', NODE_X);

    // NODE_Z is neither a direct peer nor discovered — several hops away.
    // Origination must still work: the packet is flooded toward it.
    setVoiceDestinationNodeId(NODE_Z);
    clearSendCalls();
    sttResult('to a far away node');
    await settle();

    const frames = decodeSendsTo('C');
    expect(frames.length).toBe(1);
    const { envelope } = decodeBitchatFrame(frames[0].base64);
    expect(envelope.destinationNodeId).toBe(NODE_Z);
  });

  it('F. changing the destination affects only subsequent voice sends', async () => {
    setStorageMode('resolve');
    const r = await renderHook();
    api = r.api;

    await announceToConnectedPeer('C');
    await enableVoice('C');
    await registerRemotePeer('C', NODE_X);
    await registerRemotePeer('D', NODE_Y);

    setVoiceDestinationNodeId(NODE_X);
    clearSendCalls();
    sttResult('first to x');
    await settle();
    const firstEnv = decodeBitchatFrame(decodeSendsTo('C')[0].base64).envelope;
    expect(firstEnv.destinationNodeId).toBe(NODE_X);

    // Change destination; the NEXT send uses it.
    clearSendCalls();
    setVoiceDestinationNodeId(NODE_Y);
    sttResult('second to y');
    await settle();
    const secondEnv = decodeBitchatFrame(decodeSendsTo('C')[0].base64).envelope;
    expect(secondEnv.destinationNodeId).toBe(NODE_Y);
    expect(secondEnv.packetId).not.toBe(firstEnv.packetId);
  });

  it('G. broadcast remains explicit and is never accidental', async () => {
    setStorageMode('resolve');
    const r = await renderHook();
    api = r.api;

    await announceToConnectedPeer('C');
    await enableVoice('C');
    await registerRemotePeer('C', NODE_X);

    // Explicitly return to broadcast after selecting a unicast destination.
    setVoiceDestinationNodeId(NODE_X);
    setVoiceDestinationNodeId(NODE_ID_BROADCAST);
    clearSendCalls();
    sttResult('broadcast again');
    await settle();

    const frames = decodeSendsTo('C');
    expect(frames.length).toBe(1);
    const { envelope } = decodeBitchatFrame(frames[0].base64);
    expect(envelope.destinationNodeId).toBe(NODE_ID_BROADCAST);
  });

  it('H. disconnecting a BLE peer does not corrupt the logical destination value', async () => {
    setStorageMode('resolve');
    const r = await renderHook();
    api = r.api;

    await announceToConnectedPeer('C');
    await enableVoice('C');
    await registerRemotePeer('C', NODE_X);
    setVoiceDestinationNodeId(NODE_X);

    // C disconnects — transport state for C is removed, the logical
    // destination (a nodeId) must survive untouched.
    act(() => {
      emitBLE('BLE_DISCONNECTED', { deviceId: 'C', reason: 'test' });
    });
    await settle();

    expect(getVoiceDestinationNodeId()).toBe(NODE_X);

    // A later peer still routes toward the unchanged destination. (The
    // existing lifecycle turns voice mode off on disconnect, so re-enable
    // it for the new peer before sending.)
    await announceToConnectedPeer('D');
    await registerRemotePeer('D', NODE_Y);
    await enableVoice('D');
    clearSendCalls();
    sttResult('after disconnect');
    await settle();

    const frames = decodeSendsTo('D');
    expect(frames.length).toBeGreaterThan(0);
    const dataFrames = frames
      .map((f) => ({ f, env: decodeBitchatFrame(f.base64).envelope }))
      .filter(({ env }) => env.packetType === PACKET_TYPE_DATA);
    expect(dataFrames.length).toBe(1);
    expect(dataFrames[0].env.destinationNodeId).toBe(NODE_X);
  });
  it('I. discovered-but-not-directly-connected node can be selected', async () => {
    setStorageMode('resolve');
    const r = await renderHook();
    api = r.api;

    await announceToConnectedPeer('C');
    await enableVoice('C');
    await registerRemotePeer('C', NODE_X);

    // A DISCOVERY packet from C reveals NODE_Z exists somewhere in the mesh
    // (discovered, NOT a direct BLE peer).
    const discoveryPacket: BitChatPacket = {
      version: 0x01,
      packetType: PACKET_TYPE_DISCOVERY,
      ttl: DEFAULT_TTL,
      sourceNodeId: NODE_X,
      destinationNodeId: NODE_ID_BROADCAST,
      packetId: normalizePacketId(BigInt(9101)),
      flags: FLAGS_NONE,
      payload: encodeDiscovery(NODE_Z),
    };
    await deliverData('C', bitChatEncode(discoveryPacket));

    // The discovered node appears as a non-direct destination.
    const dests = api().getMeshDestinations();
    const zDest = dests.find((d) => d.nodeId === NODE_Z);
    expect(zDest).toBeDefined();
    expect(zDest!.direct).toBe(false);

    // Selecting it works even though there is no direct BLE path to Z.
    setVoiceDestinationNodeId(NODE_Z);
    clearSendCalls();
    sttResult('to discovered z');
    await settle();

    const frames = decodeSendsTo('C');
    const dataFrames = frames
      .map((f) => ({ f, env: decodeBitchatFrame(f.base64).envelope }))
      .filter(({ env }) => env.packetType === PACKET_TYPE_DATA);
    expect(dataFrames.length).toBe(1);
    expect(dataFrames[0].env.destinationNodeId).toBe(NODE_Z);
  });

  it('J. incoming voice delivery remains unchanged for local-addressed packets', async () => {
    setStorageMode('resolve');
    const r = await renderHook();
    api = r.api;

    await announceToConnectedPeer('C');
    await enableVoice('C');
    await settle();

    // Learn our own nodeId from the ANNOUNCE we sent to C.
    const announceFrames = decodeSendsTo('C');
    expect(announceFrames.length).toBe(1);
    const ourNodeId = bitChatDecode(
      v6bDecode(base64ToBytes(announceFrames[0].base64)).payload,
    ).sourceNodeId;

    await registerRemotePeer('C', NODE_X);

    // A packet explicitly addressed to THIS node is delivered locally (TTS).
    const { v6a } = semanticPayload('addressed to me');
    const envelope = dataEnvelope({
      sourceNodeId: NODE_X,
      destinationNodeId: ourNodeId,
      packetId: BigInt(9102),
      ttl: DEFAULT_TTL,
      payload: v6a,
    });
    ttsSpeakMock().mockClear();
    await deliverData('C', envelope);
    expect(ttsSpeakMock()).toHaveBeenCalledTimes(1);
    expect(ttsSpeakMock().mock.calls[0][0]).toBe('addressed to me');
  });

  it('K/L. single-peer explicit selection works; multi-peer fan-out with a unicast destination is intact', async () => {
    setStorageMode('resolve');
    const r = await renderHook();
    api = r.api;

    await announceToConnectedPeer('C');
    await announceToConnectedPeer('D');
    await enableVoice('C');
    await registerRemotePeer('C', NODE_X);
    await registerRemotePeer('D', NODE_Y);

    // K: single-peer usability — explicit selection of the direct peer.
    setVoiceDestinationNodeId(NODE_X);
    clearSendCalls();
    sttResult('single peer to x');
    await settle();
    const cFrames = decodeSendsTo('C');
    const dFrames = decodeSendsTo('D');
    expect(cFrames.length).toBe(1);
    expect(dFrames.length).toBe(1);

    // L: both targets carry the same logical message addressed to NODE_X.
    const cEnv = decodeBitchatFrame(cFrames[0].base64).envelope;
    const dEnv = decodeBitchatFrame(dFrames[0].base64).envelope;
    expect(cEnv.packetId).toBe(dEnv.packetId);
    expect(cEnv.destinationNodeId).toBe(NODE_X);
    expect(dEnv.destinationNodeId).toBe(NODE_X);

    // No legacy untargeted send ever occurs for BITCHAT traffic.
    const untargeted = mockNativeBLE.send.mock.calls.filter((call: any[]) => call.length < 2);
    expect(untargeted).toHaveLength(0);
  });
});
// ─────────────────────────────────────────────────────────────────────────
// V9E Step 11 — multi-phone integration chain (A → B → C)
//
// Three simulated phones, each with its own hook instance, adapter, and
// node identity (primed via the AsyncStorage fake). The wire between phones
// is simulated manually: frames a phone emits via NativeBLE.send are
// captured and delivered to the next phone's BLE_DATA_RECEIVED handler.
//
// This proves the full layer stack composes: STT → BITCHAT originate →
// relay → local delivery → TTS only at the destination, with BLE device
// identity kept separate from BITCHAT node identity and per-phone V8
// sequence streams independent per hop.
// ─────────────────────────────────────────────────────────────────────────
describe('useBLEVoiceMode — Step 11 multi-phone integration chain', () => {
  const NODE_A = '0x00000000000000a1'; // Phone A's BITCHAT identity
  const NODE_B = '0x00000000000000b2'; // Phone B's BITCHAT identity
  const NODE_C = '0x00000000000000c3'; // Phone C's BITCHAT identity

  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      await act(async () => {});
    }
  };

  const makeAnnounceBytes = (nodeId: string): Uint8Array => {
    const remote = new BitChatBLEAdapter({
      localNodeId: nodeId,
      bleSend: async () => {},
      onLocalDeliver: () => {},
    });
    return remote.createAnnouncePacket();
  };

  const wrapV6BBitchat = (payload: Uint8Array, seq: number = 0): string => {
    const frame = v6bEncode(seq, V6B_FRAME_BITCHAT, payload);
    return bytesToBase64(frame);
  };

  const decodeBitchatFrame = (base64: string) => {
    const frame = v6bDecode(base64ToBytes(base64));
    expect(frame.frameType).toBe(V6B_FRAME_BITCHAT);
    const envelope = bitChatDecode(frame.payload);
    return { frame, envelope };
  };

  const ttsSpeakMock = () => (rnMock.NativeModules.NativeTTS.speak as jest.Mock);

  const unmountPhone = async (renderer: TestRenderer.ReactTestRenderer) => {
    await act(async () => {
      renderer.unmount();
    });
    await act(async () => {});
  };

  /** A peer connection event → this phone announces to that BLE peer. */
  const announceToConnectedPeer = async (blePeerId: string) => {
    act(() => {
      emitBLE('BLE_CONNECTED', { deviceId: blePeerId, mtu: 512 });
    });
    await settle();
  };

  /** Deliver a remote phone's ANNOUNCE to this phone (registers the peer). */
  const registerRemotePeer = async (blePeerId: string, remoteNodeId: string) => {
    act(() => {
      emitBLE('BLE_DATA_RECEIVED', {
        data: wrapV6BBitchat(makeAnnounceBytes(remoteNodeId), 0),
        fromDevice: blePeerId,
      });
    });
    await settle();
  };

  /** Deliver a captured raw V6B frame (base64) from a peer to this phone. */
  const deliverFrame = async (fromPeer: string, base64: string) => {
    act(() => {
      emitBLE('BLE_DATA_RECEIVED', { data: base64, fromDevice: fromPeer });
    });
    await settle();
  };

  it('A→B→C: STT at A, relay at B with no TTS and no bounce-back, TTS only at C', async () => {
    // ── Phone A ──────────────────────────────────────────────────
    setStorageMode('resolve');
    setStorageMap({ bitchat_node_id: NODE_A });
    const a = await renderHook();
    api = a.api;

    // A ↔ B connection: A announces to B; B's ANNOUNCE registers B at A.
    await announceToConnectedPeer('B');
    await registerRemotePeer('B', NODE_B);
    await enableVoice('B');
    setVoiceDestinationNodeId(NODE_C);

    clearSendCalls();
    sttResult('hello from A');
    await settle();

    const aFrames = decodeSendsTo('B');
    expect(aFrames.length).toBe(1); // exactly one logical transmission
    const aFrame = decodeBitchatFrame(aFrames[0].base64);
    expect(aFrame.envelope.packetType).toBe(PACKET_TYPE_DATA);
    // Logical identities are BITCHAT nodeIds — never BLE deviceIds.
    expect(aFrame.envelope.sourceNodeId).toBe(NODE_A);
    expect(aFrame.envelope.destinationNodeId).toBe(NODE_C);
    expect(NODE_A).not.toBe('A');
    expect(NODE_B).not.toBe('B');
    expect(NODE_C).not.toBe('C');
    // Originated copy: TTL decremented once for the forwarded hop.
    expect(aFrame.envelope.ttl).toBe(DEFAULT_TTL - 1);
    // A's per-peer V8 stream for B: ANNOUNCE took seq 0, DATA is seq 1.
    expect(aFrame.frame.sequence).toBe(1);
    await unmountPhone(a.renderer);

    // ── Phone B (relay) ──────────────────────────────────────────
    setStorageMap({ bitchat_node_id: NODE_B });
    const b = await renderHook();
    api = b.api;

    // B connects to both A and C; both register via their ANNOUNCEs.
    await announceToConnectedPeer('A');
    await announceToConnectedPeer('C');
    await registerRemotePeer('A', NODE_A);
    await registerRemotePeer('C', NODE_C);

    clearSendCalls();
    // A's DATA arrives at B from BLE deviceId 'A'.
    await deliverFrame('A', aFrames[0].base64);

    const bToC = decodeSendsTo('C');
    const bToA = decodeSendsTo('A');
    // B relays exactly one copy toward C and never bounces back to A.
    expect(bToC.length).toBe(1);
    expect(bToA.length).toBe(0);

    const bFrame = decodeBitchatFrame(bToC[0].base64);
    expect(bFrame.envelope.packetType).toBe(PACKET_TYPE_DATA);
    expect(bFrame.envelope.sourceNodeId).toBe(NODE_A); // identity preserved
    expect(bFrame.envelope.destinationNodeId).toBe(NODE_C);
    expect(bFrame.envelope.packetId).toBe(aFrame.envelope.packetId);
    expect(bFrame.envelope.ttl).toBe(DEFAULT_TTL - 2); // decremented once at B
    // B's per-peer V8 stream for C is independent of A's stream for B:
    // B's ANNOUNCE to C consumed seq 0, so the relayed DATA is seq 1.
    expect(bFrame.frame.sequence).toBe(1);
    // Relay node must NOT speak the message.
    expect(ttsSpeakMock()).not.toHaveBeenCalled();

    // Duplicate re-delivery of the same packet is suppressed by dedup.
    await deliverFrame('A', aFrames[0].base64);
    expect(decodeSendsTo('C').length).toBe(1);
    await unmountPhone(b.renderer);

    // ── Phone C (destination) ────────────────────────────────────
    setStorageMap({ bitchat_node_id: NODE_C });
    const c = await renderHook();
    api = c.api;

    await announceToConnectedPeer('B');
    await registerRemotePeer('B', NODE_B);
    await enableVoice('B');

    ttsSpeakMock().mockClear();
    await deliverFrame('B', bToC[0].base64);

    // C is the destination: TTS speaks the original message exactly once.
    expect(ttsSpeakMock()).toHaveBeenCalledTimes(1);
    expect(ttsSpeakMock().mock.calls[0][0]).toBe('hello from A');
    // C's identity is its own nodeId, distinct from B's identity and
    // from B's BLE deviceId.
    expect(getStorageMap()['bitchat_node_id']).toBe(NODE_C);
    expect(NODE_C).not.toBe(NODE_B);
    await unmountPhone(c.renderer);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// V9E Step 11 — receive-path hardening regression
// ─────────────────────────────────────────────────────────────────────────
describe('useBLEVoiceMode — Step 11 receive-path hardening', () => {
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      await act(async () => {});
    }
  };

  const ttsSpeakMock = () => (rnMock.NativeModules.NativeTTS.speak as jest.Mock);

  const announceToConnectedPeer = async (blePeerId: string) => {
    act(() => {
      emitBLE('BLE_CONNECTED', { deviceId: blePeerId, mtu: 512 });
    });
    await settle();
  };

  const decodeBitchatFrame = (base64: string) => {
    const frame = v6bDecode(base64ToBytes(base64));
    expect(frame.frameType).toBe(V6B_FRAME_BITCHAT);
    const envelope = bitChatDecode(frame.payload);
    return { frame, envelope };
  };

  const makeAnnounceBytes = (nodeId: string): Uint8Array => {
    const remote = new BitChatBLEAdapter({
      localNodeId: nodeId,
      bleSend: async () => {},
      onLocalDeliver: () => {},
    });
    return remote.createAnnouncePacket();
  };

  const wrapV6BBitchat = (payload: Uint8Array, seq: number = 0): string => {
    const frame = v6bEncode(seq, V6B_FRAME_BITCHAT, payload);
    return bytesToBase64(frame);
  };

  const NODE_X = '0x00000000000000aa'; // direct peer behind BLE "C"

  it('malformed V6B frames are dropped safely (no crash, no TTS, no relay)', async () => {
    setStorageMode('resolve');
    const r = await renderHook();
    api = r.api;

    await announceToConnectedPeer('C');
    await enableVoice('C');
    // Register the direct peer so the post-check STT send has a target.
    act(() => {
      emitBLE('BLE_DATA_RECEIVED', {
        data: wrapV6BBitchat(makeAnnounceBytes(NODE_X), 0),
        fromDevice: 'C',
      });
    });
    await settle();

    ttsSpeakMock().mockClear();

    // A truncated frame (version byte only) makes v6bDecode throw. The
    // receive handler must reject it without propagating the exception.
    const malformed = bytesToBase64(new Uint8Array([V6B_VERSION]));
    expect(() => {
      act(() => {
        emitBLE('BLE_DATA_RECEIVED', { data: malformed, fromDevice: 'C' });
      });
    }).not.toThrow();
    await settle();

    // Control/unknown traffic never becomes speech.
    expect(ttsSpeakMock()).not.toHaveBeenCalled();

    // The mesh and voice paths remain healthy afterwards.
    clearSendCalls();
    sttResult('still working');
    await settle();
    const frames = decodeSendsTo('C');
    const dataFrames = frames
      .map((f) => ({ f, env: decodeBitchatFrame(f.base64).envelope }))
      .filter(({ env }) => env.packetType === PACKET_TYPE_DATA);
    expect(dataFrames.length).toBe(1);
  });

  it('garbage (non-protocol) bytes never reach TTS', async () => {
    setStorageMode('resolve');
    const r = await renderHook();
    api = r.api;

    await announceToConnectedPeer('C');
    await enableVoice('C');
    await settle();

    ttsSpeakMock().mockClear();
    act(() => {
      emitBLE('BLE_DATA_RECEIVED', { data: 'AAECAwQFBgc=', fromDevice: 'C' });
    });
    await settle();

    expect(ttsSpeakMock()).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// MVP hardening — ANNOUNCE bounded retry & symmetric handshake (direct A→B)
// ═══════════════════════════════════════════════════════════════════════

describe('useBLEVoiceMode — ANNOUNCE bounded retry & handshake', () => {
  const NODE_B = '0x00000000000000bb';

  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      await act(async () => {});
    }
  };

  const makeAnnounceBytes = (nodeId: string): Uint8Array => {
    const remote = new BitChatBLEAdapter({
      localNodeId: nodeId,
      bleSend: async () => {},
      onLocalDeliver: () => {},
    });
    return remote.createAnnouncePacket();
  };

  const wrapV6BBitchat = (payload: Uint8Array, seq: number = 0): string => {
    const frame = v6bEncode(seq, V6B_FRAME_BITCHAT, payload);
    return bytesToBase64(frame);
  };

  const announceToConnectedPeer = async (blePeerId: string, mtu: number = 512) => {
    act(() => {
      emitBLE('BLE_CONNECTED', { deviceId: blePeerId, mtu });
    });
    await settle();
  };

  const registerRemotePeer = async (blePeerId: string, remoteNodeId: string) => {
    act(() => {
      emitBLE('BLE_DATA_RECEIVED', {
        data: wrapV6BBitchat(makeAnnounceBytes(remoteNodeId), 0),
        fromDevice: blePeerId,
      });
    });
    await settle();
  };

  /**
   * Count SUCCESSFUL ANNOUNCE sends to a device. A mock 'return' result only
   * means the async send returned a promise — the CCCD-race failure rejects
   * that promise later, so each result value is awaited to filter failures.
   */
  const announceSendsTo = async (deviceId: string): Promise<number> => {
    const calls = (mockNativeBLE.send as jest.Mock).mock.calls;
    const results = (mockNativeBLE.send as jest.Mock).mock.results;
    let count = 0;
    for (let i = 0; i < calls.length; i++) {
      const result = results[i];
      if (!result || result.type !== 'return') continue; // sync throw
      try {
        await result.value; // rejects → the send failed (e.g. NOTIFY_FAILED)
      } catch {
        continue;
      }
      try {
        const bytes = base64ToBytes(calls[i][0]);
        const frame = v6bDecode(bytes);
        if (frame.frameType !== V6B_FRAME_BITCHAT) continue;
        // Peer-targeted sends carry options { deviceId } as the 2nd arg.
        const target = calls[i][1]?.deviceId ?? calls[i][1] ?? null;
        if (deviceId !== null && target != null && target !== deviceId) continue;
        if (bitChatDecode(frame.payload).packetType === PACKET_TYPE_ANNOUNCE) count++;
      } catch {
        /* not a decodable BITCHAT frame */
      }
    }
    return count;
  };

  /** Count ALL ANNOUNCE send attempts to a device (successful or not). */
  const announceAttemptsTo = (deviceId: string): number => {
    const calls = (mockNativeBLE.send as jest.Mock).mock.calls;
    let count = 0;
    calls.forEach((call: any[]) => {
      try {
        const bytes = base64ToBytes(call[0]);
        const frame = v6bDecode(bytes);
        if (frame.frameType !== V6B_FRAME_BITCHAT) return;
        const target = call[1]?.deviceId ?? call[1] ?? null;
        if (deviceId !== null && target != null && target !== deviceId) return;
        if (bitChatDecode(frame.payload).packetType === PACKET_TYPE_ANNOUNCE) count++;
      } catch {
        /* not a decodable BITCHAT frame */
      }
    });
    return count;
  };

  it('failed first ANNOUNCE is retried with bounded spacing while the link stays up', async () => {
    setStorageMode('resolve');
    const r = await renderHook();
    api = r.api;

    // Simulate a persistently failing link: EVERY announce send fails
    // natively (peer notifications never become ready) so the full bounded
    // retry schedule [500ms, 1500ms, 4000ms] must play out.
    mockNativeBLE.send.mockImplementation(async () => {
      throw new Error('NOTIFY_FAILED');
    });

    await announceToConnectedPeer('B');
    // Initial attempt failed; no retry has fired yet.
    expect(announceAttemptsTo('B')).toBe(1);
    expect(await announceSendsTo('B')).toBe(0);

    // t=500ms retry fires (and also fails).
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    await settle();
    expect(announceAttemptsTo('B')).toBe(2);

    // t=1500ms retry fires.
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });
    await settle();
    expect(announceAttemptsTo('B')).toBe(3);

    // t=4000ms retry fires — last one on the schedule.
    await act(async () => {
      jest.advanceTimersByTime(4000);
    });
    await settle();
    expect(announceAttemptsTo('B')).toBe(4);

    // Bounded: no further attempts after the last retry.
    await act(async () => {
      jest.advanceTimersByTime(20000);
    });
    await settle();
    expect(announceAttemptsTo('B')).toBe(4);
    expect(await announceSendsTo('B')).toBe(0);

    // Restore the default send implementation for subsequent tests.
    mockNativeBLE.send.mockReset();
    mockNativeBLE.send.mockImplementation(async () => true);
  });

  it('server-role retry continues even when the BITCHAT mapping has NOT formed (link liveness, not mapping, gates retries)', async () => {
    setStorageMode('resolve');
    const r = await renderHook();
    api = r.api;

    // Connection up; our announce send failed (CCCD race) so the peer has
    // NOT registered us — the BITCHAT mapping for 'B' does not exist.
    mockNativeBLE.send.mockImplementationOnce(async () => {
      throw new Error('NOTIFY_FAILED');
    });
    await announceToConnectedPeer('B');
    expect(await announceSendsTo('B')).toBe(0);

    // Retries must still fire despite the missing mapping. (The previous
    // mapping-based liveness check aborted here — the exact bug this
    // liveness fix closes.) The t=500ms retry goes out and succeeds —
    // proving liveness, not mapping, gates the retry loop.
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    await settle();
    expect(announceAttemptsTo('B')).toBe(2);
    expect(await announceSendsTo('B')).toBe(1);
  });

  it('disconnect stops retries; reconnect restarts a fresh bounded loop', async () => {
    setStorageMode('resolve');
    const r = await renderHook();
    api = r.api;

    mockNativeBLE.send.mockImplementationOnce(async () => {
      throw new Error('NOTIFY_FAILED');
    });
    await announceToConnectedPeer('B');
    expect(await announceSendsTo('B')).toBe(0);

    // Link drops before the first retry fires.
    act(() => {
      emitBLE('BLE_DISCONNECTED', { deviceId: 'B', reason: 'LOCAL' });
    });
    await settle();

    await act(async () => {
      jest.advanceTimersByTime(30000);
    });
    await settle();
    // No retry after disconnect.
    expect(await announceSendsTo('B')).toBe(0);

    // Reconnect under a new native BLE key → fresh announce loop.
    await announceToConnectedPeer('B_reconnected');
    expect(await announceSendsTo('B_reconnected')).toBe(1);

    // The new key has one bounded initial send and no duplicate loop.
    await act(async () => {
      jest.advanceTimersByTime(20000);
    });
    await settle();
    expect(await announceSendsTo('B_reconnected')).toBe(1);
  });

  it('disconnect clears direct route readiness and reconnect requires a fresh ANNOUNCE', async () => {
    setStorageMode('resolve');
    setConnectedDeviceIds(['B']);
    const r = await renderHook();
    api = r.api;

    await announceToConnectedPeer('B');
    await registerRemotePeer('B', NODE_B);
    await enableVoice('B');
    expect(api().status).toBe('WAITING_FOR_SPEECH');

    act(() => {
      emitBLE('BLE_DISCONNECTED', { deviceId: 'B', reason: 'REMOTE' });
    });
    await settle();
    expect(api().enabled).toBe(false);

    await announceToConnectedPeer('B');
    await enableVoice('B');
    expect(api().status).toBe('CONNECTING_MESH_ROUTE');
    expect(await api().beginPttTurn()).toBe(false);

    await registerRemotePeer('B', NODE_B);
    expect(api().status).toBe('WAITING_FOR_SPEECH');
  });

  it('incoming ANNOUNCE answers with our own ANNOUNCE; duplicate ANNOUNCE triggers no further answer (no loop)', async () => {
    setStorageMode('resolve');
    const r = await renderHook();
    api = r.api;

    // Both connection-time announces lost: ours fails, B never sent one.
    mockNativeBLE.send.mockImplementationOnce(async () => {
      throw new Error('NOTIFY_FAILED');
    });
    await announceToConnectedPeer('B');
    expect(await announceSendsTo('B')).toBe(0);

    // Later, B's ANNOUNCE finally arrives (its retry worked).
    await registerRemotePeer('B', NODE_B);

    // The handshake (or an in-flight retry) must have answered.
    const afterHandshake = await announceSendsTo('B');
    expect(afterHandshake).toBeGreaterThanOrEqual(1);

    // Duplicate ANNOUNCE from B must NOT trigger another answer.
    act(() => {
      emitBLE('BLE_DATA_RECEIVED', {
        data: wrapV6BBitchat(makeAnnounceBytes(NODE_B), 1),
        fromDevice: 'B',
      });
    });
    await settle();
    const afterDuplicate = await announceSendsTo('B');
    expect(afterDuplicate).toBe(afterHandshake);

    // And the bounded retry schedule adds nothing further once announced.
    await act(async () => {
      jest.advanceTimersByTime(20000);
    });
    await settle();
    expect(await announceSendsTo('B')).toBe(afterHandshake);
  });
});
