/**
 * V9E Step 5 tests — peer-aware useBLE state model.
 *
 * The NativeBLE native module is replaced with a controllable fake so
 * multi-peer connection/disconnection/receive flows can be exercised
 * deterministically without any platform code.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { useBLE, PeerBLEState } from '../useBLE';

// ── Controllable NativeBLE fake ────────────────────────────────────────
//
// Everything the factory references must live inside it (jest hoists
// jest.mock above the module body). Control handles are re-exported and
// reached via jest.requireMock from the tests.

jest.mock('../../native/NativeBLE', () => {
  const listeners = new Map<string, Set<(event?: any) => void>>();

  const subscribe = (name: string, cb: (event?: any) => void) => {
    let set = listeners.get(name);
    if (!set) {
      set = new Set();
      listeners.set(name, set);
    }
    set.add(cb);
    return { remove: () => set!.delete(cb) };
  };

  const emit = (name: string, event?: any) => {
    const set = listeners.get(name);
    if (set) {
      Array.from(set).forEach((cb) => cb(event));
    }
  };

  const listenerCount = (name: string): number => listeners.get(name)?.size ?? 0;

  const clearListeners = () => listeners.clear();

  const EVENT = {
    DEVICE_FOUND: 'BLE_DEVICE_FOUND',
    SCAN_ERROR: 'BLE_SCAN_ERROR',
    ADVERTISING_STARTED: 'BLE_ADVERTISING_STARTED',
    ADVERTISING_STOPPED: 'BLE_ADVERTISING_STOPPED',
    ERROR: 'BLE_ERROR',
    CONNECTING: 'BLE_CONNECTING',
    CONNECTED: 'BLE_CONNECTED',
    DISCONNECTED: 'BLE_DISCONNECTED',
    DATA_RECEIVED: 'BLE_DATA_RECEIVED',
    CONNECTION_ERROR: 'BLE_CONNECTION_ERROR',
  };

  return {
    __esModule: true,
    default: {
      // V1 discovery methods
      getDeviceId: jest.fn(async () => 'LOCAL'),
      isBluetoothEnabled: jest.fn(async () => true),
      getMissingPermissions: jest.fn(async () => []),
      startScanning: jest.fn(async () => true),
      stopScanning: jest.fn(async () => true),
      isScanning: jest.fn(async () => false),
      startAdvertising: jest.fn(async () => true),
      stopAdvertising: jest.fn(async () => true),
      isAdvertising: jest.fn(async () => false),
      // V2 GATT methods
      connect: jest.fn(async () => true),
      disconnect: jest.fn(async () => true),
      send: jest.fn(async () => true),
      getConnectionState: jest.fn(async () => ({
        state: 'IDLE',
        deviceId: '',
        mtu: 23,
      })),
      // Event listeners
      onDeviceFound: (cb: (event?: any) => void) => subscribe(EVENT.DEVICE_FOUND, cb),
      onScanError: (cb: (event?: any) => void) => subscribe(EVENT.SCAN_ERROR, cb),
      onAdvertisingStarted: (cb: (event?: any) => void) => subscribe(EVENT.ADVERTISING_STARTED, cb),
      onAdvertisingStopped: (cb: (event?: any) => void) => subscribe(EVENT.ADVERTISING_STOPPED, cb),
      onError: (cb: (event?: any) => void) => subscribe(EVENT.ERROR, cb),
      onConnecting: (cb: (event?: any) => void) => subscribe(EVENT.CONNECTING, cb),
      onConnected: (cb: (event?: any) => void) => subscribe(EVENT.CONNECTED, cb),
      onDisconnected: (cb: (event?: any) => void) => subscribe(EVENT.DISCONNECTED, cb),
      onDataReceived: (cb: (event?: any) => void) => subscribe(EVENT.DATA_RECEIVED, cb),
      onConnectionError: (cb: (event?: any) => void) => subscribe(EVENT.CONNECTION_ERROR, cb),
    },
    // Test control handles
    __emit: emit,
    __listenerCount: listenerCount,
    __clearListeners: clearListeners,
  };
});

// Access the fake module (typed loosely — it replaces the native module).
const nativeMock: any = jest.requireMock('../../native/NativeBLE');
const mockNativeBLE = nativeMock.default;
const emitEvent = nativeMock.__emit as (name: string, event?: any) => void;

type HookApi = ReturnType<typeof useBLE>;

function peerStateOf(api: HookApi, deviceId: string): PeerBLEState | undefined {
  return api.peers.get(deviceId);
}

function connectedPeerIds(api: HookApi): string[] {
  return Array.from(api.peers.entries())
    .filter(([, s]) => s.state === 'CONNECTED')
    .map(([id]) => id);
}

// ── Test harness ───────────────────────────────────────────────────────
//
// The hook's return value is captured into a mutable ref on every render so
// assertions always observe the LATEST render, never a stale snapshot.

async function renderUseBLE() {
  const apiRef: { current: HookApi | null } = { current: null };
  let renderer!: TestRenderer.ReactTestRenderer;

  const Harness = () => {
    apiRef.current = useBLE();
    return null;
  };

  await act(async () => {
    renderer = TestRenderer.create(<Harness />);
  });
  // Flush the async init effect (isBluetoothEnabled / getDeviceId).
  await act(async () => {});

  return { renderer, api: () => apiRef.current! };
}

async function connectPeer(api: () => HookApi, deviceId: string) {
  await act(async () => {
    await api().connect(deviceId);
  });
}

async function emitConnected(mtu: number, deviceId: string) {
  await act(async () => {
    emitEvent('BLE_CONNECTED', { deviceId, mtu });
  });
}

async function emitDisconnected(deviceId: string) {
  await act(async () => {
    emitEvent('BLE_DISCONNECTED', { deviceId, reason: 'REMOTE' });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  nativeMock.__clearListeners();
});

// ── Tests ─────────────────────────────────────────────────────────────

describe('useBLE — per-peer connection state', () => {
  it('1. initial peer map is empty with IDLE legacy state', async () => {
    const { api } = await renderUseBLE();
    expect(api().peers.size).toBe(0);
    expect(api().connectionState).toBe('IDLE');
    expect(api().connectedDeviceId).toBeNull();
    expect(api().mtu).toBe(23);
  });

  it('2. connect(C) creates C as CONNECTING', async () => {
    const { api } = await renderUseBLE();
    await connectPeer(api, 'C');
    expect(mockNativeBLE.connect).toHaveBeenCalledWith('C');
    const c = peerStateOf(api(), 'C');
    expect(c).toBeDefined();
    expect(c!.state).toBe('CONNECTING');
    expect(c!.role).toBe('CLIENT');
  });

  it('3. connect(D) is allowed while C is connected', async () => {
    const { api } = await renderUseBLE();
    await connectPeer(api, 'C');
    await emitConnected(512, 'C');
    await connectPeer(api, 'D');
    expect(mockNativeBLE.connect).toHaveBeenCalledTimes(2);
    expect(peerStateOf(api(), 'C')!.state).toBe('CONNECTED');
    expect(peerStateOf(api(), 'D')!.state).toBe('CONNECTING');
  });

  it('4. C and D coexist in the peers map', async () => {
    const { api } = await renderUseBLE();
    await connectPeer(api, 'C');
    await emitConnected(512, 'C');
    await connectPeer(api, 'D');
    await emitConnected(247, 'D');
    expect(api().peers.size).toBe(2);
    expect(connectedPeerIds(api()).sort()).toEqual(['C', 'D']);
  });

  it('5. BLE_CONNECTED(C) updates only C', async () => {
    const { api } = await renderUseBLE();
    await connectPeer(api, 'C');
    await connectPeer(api, 'D');
    await emitConnected(512, 'C');
    // D is still CONNECTING, untouched by C's event.
    expect(peerStateOf(api(), 'C')).toEqual({
      deviceId: 'C',
      state: 'CONNECTED',
      mtu: 512,
      role: 'CLIENT',
    });
    expect(peerStateOf(api(), 'D')!.state).toBe('CONNECTING');
  });

  it('6. BLE_CONNECTED(D) updates only D', async () => {
    const { api } = await renderUseBLE();
    await connectPeer(api, 'C');
    await emitConnected(512, 'C');
    await connectPeer(api, 'D');
    await emitConnected(247, 'D');
    expect(peerStateOf(api(), 'D')).toEqual({
      deviceId: 'D',
      state: 'CONNECTED',
      mtu: 247,
      role: 'CLIENT',
    });
    // C untouched with its own MTU.
    expect(peerStateOf(api(), 'C')).toEqual({
      deviceId: 'C',
      state: 'CONNECTED',
      mtu: 512,
      role: 'CLIENT',
    });
  });

  it('7. BLE_DISCONNECTED(C) leaves D untouched', async () => {
    const { api } = await renderUseBLE();
    await connectPeer(api, 'C');
    await emitConnected(512, 'C');
    await connectPeer(api, 'D');
    await emitConnected(247, 'D');
    await emitDisconnected('C');
    expect(api().peers.has('C')).toBe(false);
    expect(peerStateOf(api(), 'D')).toEqual({
      deviceId: 'D',
      state: 'CONNECTED',
      mtu: 247,
      role: 'CLIENT',
    });
  });

  it('8. BLE_DISCONNECTED(D) leaves C untouched', async () => {
    const { api } = await renderUseBLE();
    await connectPeer(api, 'C');
    await emitConnected(512, 'C');
    await connectPeer(api, 'D');
    await emitConnected(247, 'D');
    await emitDisconnected('D');
    expect(api().peers.has('D')).toBe(false);
    expect(peerStateOf(api(), 'C')).toEqual({
      deviceId: 'C',
      state: 'CONNECTED',
      mtu: 512,
      role: 'CLIENT',
    });
  });

  it('9. three peers coexist independently', async () => {
    const { api } = await renderUseBLE();
    await connectPeer(api, 'C');
    await emitConnected(512, 'C');
    await connectPeer(api, 'D');
    await emitConnected(247, 'D');
    await connectPeer(api, 'E');
    await emitConnected(185, 'E');
    expect(api().peers.size).toBe(3);
    expect(peerStateOf(api(), 'C')!.mtu).toBe(512);
    expect(peerStateOf(api(), 'D')!.mtu).toBe(247);
    expect(peerStateOf(api(), 'E')!.mtu).toBe(185);
  });

  it('10. peer-targeted send(C) calls NativeBLE.send(data, C)', async () => {
    const { api } = await renderUseBLE();
    await connectPeer(api, 'C');
    await emitConnected(512, 'C');
    await act(async () => {
      await api().send('hello', 'C');
    });
    expect(mockNativeBLE.send).toHaveBeenCalledTimes(1);
    const [encoded, target] = mockNativeBLE.send.mock.calls[0];
    expect((globalThis as any).atob(encoded)).toBe('hello');
    expect(target).toBe('C');
  });

  it('11. peer-targeted send(D) calls NativeBLE.send(data, D)', async () => {
    const { api } = await renderUseBLE();
    await connectPeer(api, 'C');
    await emitConnected(512, 'C');
    await connectPeer(api, 'D');
    await emitConnected(247, 'D');
    await act(async () => {
      await api().send('hi', 'D');
    });
    const [encoded, target] = mockNativeBLE.send.mock.calls[0];
    expect((globalThis as any).atob(encoded)).toBe('hi');
    expect(target).toBe('D');
  });

  it('12. legacy send(data) still works via the connected peer', async () => {
    const { api } = await renderUseBLE();
    await connectPeer(api, 'C');
    await emitConnected(512, 'C');
    await act(async () => {
      await api().send('legacy');
    });
    const [encoded, target] = mockNativeBLE.send.mock.calls[0];
    expect((globalThis as any).atob(encoded)).toBe('legacy');
    expect(target).toBe('C');
  });

  it('12b. send with no connected peer does not call the native module', async () => {
    const { api } = await renderUseBLE();
    await act(async () => {
      await api().send('nobody');
    });
    expect(mockNativeBLE.send).not.toHaveBeenCalled();
    expect(api().connectionError).toBe('Not connected');
  });

  it('13. peer-targeted disconnect(C) calls NativeBLE.disconnect(C) and removes only C', async () => {
    const { api } = await renderUseBLE();
    await connectPeer(api, 'C');
    await emitConnected(512, 'C');
    await connectPeer(api, 'D');
    await emitConnected(247, 'D');
    await act(async () => {
      await api().disconnect('C');
    });
    expect(mockNativeBLE.disconnect).toHaveBeenCalledWith('C');
    expect(api().peers.has('C')).toBe(false);
    expect(peerStateOf(api(), 'D')).toEqual({
      deviceId: 'D',
      state: 'CONNECTED',
      mtu: 247,
      role: 'CLIENT',
    });
  });

  it('14. legacy disconnect() disconnects all and clears the map', async () => {
    const { api } = await renderUseBLE();
    await connectPeer(api, 'C');
    await emitConnected(512, 'C');
    await connectPeer(api, 'D');
    await emitConnected(247, 'D');
    await act(async () => {
      await api().disconnect();
    });
    expect(mockNativeBLE.disconnect).toHaveBeenCalledWith();
    expect(api().peers.size).toBe(0);
    expect(api().connectionState).toBe('IDLE');
  });

  it('15-17. legacy values reflect the remaining connected peer', async () => {
    const { api } = await renderUseBLE();
    await connectPeer(api, 'C');
    await emitConnected(512, 'C');
    await connectPeer(api, 'D');
    await emitConnected(247, 'D');
    await emitDisconnected('D');
    expect(api().connectedDeviceId).toBe('C');
    expect(api().connectionState).toBe('CONNECTED');
    expect(api().mtu).toBe(512);
    await emitDisconnected('C');
    expect(api().connectedDeviceId).toBeNull();
    expect(api().connectionState).toBe('IDLE');
    expect(api().mtu).toBe(23);
  });

  it('18. received data preserves fromDevice attribution', async () => {
    const { api } = await renderUseBLE();
    const payload = (globalThis as any).btoa('from C');
    await act(async () => {
      emitEvent('BLE_DATA_RECEIVED', { data: payload, fromDevice: 'C' });
    });
    expect(api().lastReceivedData).toBe('from C');
    expect(api().receivedHistory[0]).toMatchObject({
      data: 'from C',
      from: 'C',
    });
    const payloadD = (globalThis as any).btoa('from D');
    await act(async () => {
      emitEvent('BLE_DATA_RECEIVED', { data: payloadD, fromDevice: 'D' });
    });
    expect(api().receivedHistory[0]).toMatchObject({ data: 'from D', from: 'D' });
    expect(api().receivedHistory[1]).toMatchObject({ from: 'C' });
  });

  it('19. rapid connect/disconnect events do not corrupt other peer state', async () => {
    const { api } = await renderUseBLE();
    await connectPeer(api, 'C');
    await connectPeer(api, 'D');
    await connectPeer(api, 'E');
    // Burst of interleaved events for different peers.
    await act(async () => {
      emitEvent('BLE_CONNECTED', { deviceId: 'D', mtu: 247 });
      emitEvent('BLE_CONNECTED', { deviceId: 'C', mtu: 512 });
      emitEvent('BLE_DISCONNECTED', { deviceId: 'D', reason: 'REMOTE' });
      emitEvent('BLE_CONNECTED', { deviceId: 'E', mtu: 185 });
    });
    expect(peerStateOf(api(), 'C')).toEqual({
      deviceId: 'C', state: 'CONNECTED', mtu: 512, role: 'CLIENT',
    });
    expect(peerStateOf(api(), 'E')).toEqual({
      deviceId: 'E', state: 'CONNECTED', mtu: 185, role: 'CLIENT',
    });
    expect(api().peers.has('D')).toBe(false);
  });

  it('19b. connect failure for one peer does not clear the other connected peer', async () => {
    const { api } = await renderUseBLE();
    await connectPeer(api, 'C');
    await emitConnected(512, 'C');
    // Native rejects the connect attempt for D.
    mockNativeBLE.connect.mockRejectedValueOnce({
      code: 'BLE_PERMISSION_DENIED',
      message: 'nope',
    });
    await act(async () => {
      await api().connect('D');
    });
    // D's optimistic entry was reverted; C remains CONNECTED.
    expect(api().peers.has('D')).toBe(false);
    expect(peerStateOf(api(), 'C')).toEqual({
      deviceId: 'C', state: 'CONNECTED', mtu: 512, role: 'CLIENT',
    });
  });

  it('19c. duplicate connect to an already-connected peer is rejected without state loss', async () => {
    const { api } = await renderUseBLE();
    await connectPeer(api, 'C');
    await emitConnected(512, 'C');
    mockNativeBLE.connect.mockRejectedValueOnce({
      code: 'ALREADY_CONNECTED',
      message: 'Already connected to C',
    });
    await act(async () => {
      await api().connect('C');
    });
    expect(peerStateOf(api(), 'C')!.state).toBe('CONNECTED');
  });

  it('20. cleanup removes listeners on unmount', async () => {
    const { renderer, api } = await renderUseBLE();
    expect(nativeMock.__listenerCount('BLE_CONNECTED')).toBeGreaterThan(0);
    await act(async () => {
      renderer.unmount();
    });
    expect(nativeMock.__listenerCount('BLE_CONNECTED')).toBe(0);
    // Emitting after unmount must not throw.
    act(() => {
      emitEvent('BLE_CONNECTED', { deviceId: 'C', mtu: 512 });
    });
    expect(api().peers.size).toBe(0);
  });
});
