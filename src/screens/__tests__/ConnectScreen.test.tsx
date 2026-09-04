/**
 * V9E Step 8 tests — multi-peer ConnectScreen UI.
 *
 * The screen is rendered with the REAL useBLE hook. NativeBLE is replaced
 * with a controllable fake (event bus + call recording) exactly like the
 * useBLE hook tests, so discovery / connect / disconnect flows are driven
 * by emitting native events and the screen re-renders through real React
 * state. Every assertion is against the rendered UI (rows, sections,
 * action-button labels/disabled state), not transport internals.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import ConnectScreen from '../ConnectScreen';
import {
  getVoiceDestinationNodeId,
  registerMeshDestinationsProvider,
  resetVoiceDestinationStore,
} from '../../hooks/voiceDestinationStore';

// The screen imports SafeAreaView from react-native-safe-area-context.
jest.mock('react-native-safe-area-context', () => {
  const ReactMock = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    SafeAreaView: (props: any) => ReactMock.createElement(View, props),
  };
});

// ── Controllable NativeBLE fake ────────────────────────────────────────
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

  const clearListeners = () => listeners.clear();

  // Realistic connect: the native promise stays pending until the test
  // emits BLE_CONNECTED for that device (the real native layer behaves
  // this way), so the hook's optimistic CONNECTING state is preserved.
  const pendingConnects = new Map<string, () => void>();
  const connect = jest.fn(
    (deviceId: string): Promise<boolean> =>
      new Promise((resolve) => {
        pendingConnects.set(deviceId, () => resolve(true));
      }),
  );
  const resolveConnect = (deviceId: string) => {
    const done = pendingConnects.get(deviceId);
    if (done) {
      pendingConnects.delete(deviceId);
      done();
    }
  };

  return {
    __esModule: true,
    default: {
      getDeviceId: jest.fn(async () => 'LOCAL'),
      isBluetoothEnabled: jest.fn(async () => true),
      getMissingPermissions: jest.fn(async () => []),
      startScanning: jest.fn(async () => true),
      stopScanning: jest.fn(async () => true),
      isScanning: jest.fn(async () => false),
      startAdvertising: jest.fn(async () => true),
      stopAdvertising: jest.fn(async () => true),
      isAdvertising: jest.fn(async () => false),
      connect,
      disconnect: jest.fn(async () => true),
      send: jest.fn(async () => true),
      getConnectionState: jest.fn(async () => ({ state: 'IDLE', deviceId: '', mtu: 23 })),
      onDeviceFound: (cb: (event?: any) => void) => subscribe('BLE_DEVICE_FOUND', cb),
      onScanError: (cb: (event?: any) => void) => subscribe('BLE_SCAN_ERROR', cb),
      onAdvertisingStarted: (cb: (event?: any) => void) => subscribe('BLE_ADVERTISING_STARTED', cb),
      onAdvertisingStopped: (cb: (event?: any) => void) => subscribe('BLE_ADVERTISING_STOPPED', cb),
      onError: (cb: (event?: any) => void) => subscribe('BLE_ERROR', cb),
      onConnecting: (cb: (event?: any) => void) => subscribe('BLE_CONNECTING', cb),
      onConnected: (cb: (event?: any) => void) => subscribe('BLE_CONNECTED', cb),
      onDisconnected: (cb: (event?: any) => void) => subscribe('BLE_DISCONNECTED', cb),
      onDataReceived: (cb: (event?: any) => void) => subscribe('BLE_DATA_RECEIVED', cb),
      onConnectionError: (cb: (event?: any) => void) => subscribe('BLE_CONNECTION_ERROR', cb),
    },
    __emit: emit,
    __clearListeners: clearListeners,
    __resolveConnect: resolveConnect,
  };
});

const nativeMock: any = jest.requireMock('../../native/NativeBLE');
const mockNativeBLE = nativeMock.default;
const emitEvent = nativeMock.__emit as (name: string, event?: any) => void;
const resolveConnect = nativeMock.__resolveConnect as (deviceId: string) => void;

// ── Test helpers ───────────────────────────────────────────────────────

let rendererRef: { current: TestRenderer.ReactTestRenderer | null } = { current: null };

async function renderScreen(): Promise<void> {
  await act(async () => {
    rendererRef.current = TestRenderer.create(<ConnectScreen />);
  });
  // Flush the async init effect (isBluetoothEnabled / getDeviceId).
  await act(async () => {});
}

/** Emit a native event and flush React updates. */
async function emit(name: string, event?: any): Promise<void> {
  await act(async () => {
    emitEvent(name, event);
  });
  if (name === 'BLE_CONNECTED' && event && event.deviceId) {
    // BLE_CONNECTED releases the native connect() promise for that device;
    // let the hook's continuation settle in its own turn.
    await act(async () => {
      resolveConnect(event.deviceId);
    });
  }
  await act(async () => {});
}

/** Discover a device exactly as a scan callback would. */
async function discover(deviceId: string, rssi = -50): Promise<void> {
  await emit('BLE_DEVICE_FOUND', { deviceId, name: null, rssi });
}

/** Press the action button of a peer row. */
async function pressAction(deviceId: string): Promise<void> {
  const btn = actionButtonOf(deviceId);
  expect(btn).not.toBeNull();
  await act(async () => {
    btn.props.onPress();
  });
}

/** All action buttons rendered for a peer (VirtualizedList may duplicate cells). */
function actionButtonsOf(deviceId: string): any[] {
  return rendererRef.current!.root.findAll(
    (n: any) => n.props && n.props.testID === `peer-action-${deviceId}`,
  );
}

function actionButtonOf(deviceId: string): any {
  const matches = actionButtonsOf(deviceId);
  return matches.length > 0 ? matches[0] : null;
}

function hasTestID(testID: string): boolean {
  return rendererRef.current!.root.findAll((n: any) => n.props && n.props.testID === testID)
    .length > 0;
}

/** Flatten the JSON tree into text (host Text components). */
function allText(): string {
  const json: any = (rendererRef.current as any).toJSON();
  const parts: string[] = [];
  const walk = (j: any) => {
    if (typeof j === 'string' || typeof j === 'number') parts.push(String(j));
    else if (j && j.children) {
      (Array.isArray(j.children) ? j.children : [j.children]).forEach(walk);
    }
  };
  walk(json);
  return parts.join('|');
}

/** The label rendered on a peer's action button, or '<absent>' if none. */
function actionLabelOf(deviceId: string): string {
  const btn = actionButtonOf(deviceId);
  if (!btn) return '<absent>';
  return allTextOf(btn);
}

/** Flatten the JSON subtree under an instance into text. */
function allTextOf(inst: any): string {
  const parts: string[] = [];
  const collect = (n: any) => {
    if (n.children != null && Array.isArray(n.children)) {
      n.children.forEach((c: any) => {
        if (typeof c === 'string' || typeof c === 'number') parts.push(String(c));
        else if (c && c.children) collect(c);
      });
    }
  };
  collect(inst);
  if (parts.length === 0) {
    const walk = (j: any) => {
      if (typeof j === 'string' || typeof j === 'number') parts.push(String(j));
      else if (j && j.children) {
        (Array.isArray(j.children) ? j.children : [j.children]).forEach(walk);
      }
    };
    walk((inst as any).toJSON ? (inst as any).toJSON() : null);
  }
  return parts.join('');
}

/** Whether the whole rendered screen text contains the given substring. */
function screenMentions(text: string): boolean {
  return allText().includes(text);
}

beforeEach(() => {
  jest.clearAllMocks();
  nativeMock.__clearListeners();
  rendererRef = { current: null };
});

afterEach(async () => {
  if (rendererRef.current) {
    await act(async () => {
      rendererRef.current!.unmount();
      rendererRef.current = null;
    });
  }
});

// ── Tests ─────────────────────────────────────────────────────────────

describe('ConnectScreen — multi-peer UI', () => {
  it('1. renders multiple discovered devices as AVAILABLE rows', async () => {
    await renderScreen();
    await discover('Phone C', -40);
    await discover('Phone D', -50);

    expect(hasTestID('section-available')).toBe(true);
    expect(hasTestID('section-connected')).toBe(false);
    expect(screenMentions('Phone C')).toBe(true);
    expect(screenMentions('Phone D')).toBe(true);
    expect(actionLabelOf('Phone C')).toBe('CONNECT');
    expect(actionLabelOf('Phone D')).toBe('CONNECT');
  });

  it('2. one peer CONNECTED while another is DISCOVERED', async () => {
    await renderScreen();
    await discover('Phone C', -40);
    await discover('Phone D', -50);

    await pressAction('Phone C'); // CONNECT
    await emit('BLE_CONNECTED', { deviceId: 'Phone C', mtu: 512 });

    expect(hasTestID('section-connected')).toBe(true);
    expect(hasTestID('section-available')).toBe(true);
    expect(actionLabelOf('Phone C')).toBe('DISCONNECT');
    expect(actionLabelOf('Phone D')).toBe('CONNECT');
    // The connected peer's row shows CONNECTED and its MTU/role.
    const text = allText();
    expect(text).toContain('Phone C');
    expect(text).toContain('512');
    expect(text).toContain('CLIENT');
  });

  it('3. CONNECT button calls connect(C)', async () => {
    await renderScreen();
    await discover('Phone C', -40);

    mockNativeBLE.connect.mockClear();
    await pressAction('Phone C');
    expect(mockNativeBLE.connect).toHaveBeenCalledWith('Phone C');
    expect(mockNativeBLE.disconnect).not.toHaveBeenCalled();
    // Optimistic state is visible: CONNECTING badge, no DISCONNECT button.
    expect(screenMentions('CONNECTING')).toBe(true);
  });

  it('4. connect D while C is already connected is allowed', async () => {
    await renderScreen();
    await discover('Phone C', -40);
    await discover('Phone D', -50);

    // Connect C.
    await pressAction('Phone C');
    await emit('BLE_CONNECTED', { deviceId: 'Phone C', mtu: 512 });
    expect(actionLabelOf('Phone C')).toBe('DISCONNECT');

    // D remains available and enabled while C is connected.
    const dBtn = actionButtonOf('Phone D');
    expect(dBtn).not.toBeNull();
    expect(dBtn.props.disabled).toBe(false);
    expect(actionLabelOf('Phone D')).toBe('CONNECT');

    // Connect D while C is connected — allowed (no global gating).
    mockNativeBLE.connect.mockClear();
    await pressAction('Phone D');
    expect(mockNativeBLE.connect).toHaveBeenCalledWith('Phone D');
    // C's row is untouched during D's CONNECTING phase.
    expect(actionLabelOf('Phone C')).toBe('DISCONNECT');
    expect(screenMentions('CONNECTING')).toBe(true);
  });

  it('5. C and D display CONNECTED simultaneously with per-peer buttons', async () => {
    await renderScreen();
    await discover('Phone C', -40);
    await discover('Phone D', -50);

    await pressAction('Phone C');
    await emit('BLE_CONNECTED', { deviceId: 'Phone C', mtu: 512 });
    await pressAction('Phone D');
    await emit('BLE_CONNECTED', { deviceId: 'Phone D', mtu: 247 });

    // Both peers visible as CONNECTED with their own DISCONNECT buttons.
    expect(hasTestID('section-connected')).toBe(true);
    expect(actionLabelOf('Phone C')).toBe('DISCONNECT');
    expect(actionLabelOf('Phone D')).toBe('DISCONNECT');
    const text = allText();
    expect(text).toContain('512'); // C's MTU
    expect(text).toContain('247'); // D's MTU
    expect(hasTestID('section-available')).toBe(false);
  });

  it('6. DISCONNECT button on C calls disconnect(C) only', async () => {
    await renderScreen();
    await discover('Phone C', -40);
    await discover('Phone D', -50);

    // Connect both C and D.
    await pressAction('Phone C');
    await emit('BLE_CONNECTED', { deviceId: 'Phone C', mtu: 512 });
    await pressAction('Phone D');
    await emit('BLE_CONNECTED', { deviceId: 'Phone D', mtu: 247 });

    // Press DISCONNECT on C.
    mockNativeBLE.disconnect.mockClear();
    await pressAction('Phone C');
    expect(mockNativeBLE.disconnect).toHaveBeenCalledTimes(1);
    expect(mockNativeBLE.disconnect).toHaveBeenCalledWith('Phone C');
    expect(mockNativeBLE.disconnect).not.toHaveBeenCalledWith('Phone D');
    expect(mockNativeBLE.disconnect).not.toHaveBeenCalledWith(undefined);

    // C returns to AVAILABLE (still discovered) with a CONNECT button;
    // D remains CONNECTED with its own DISCONNECT button.
    expect(actionLabelOf('Phone C')).toBe('CONNECT');
    expect(actionLabelOf('Phone D')).toBe('DISCONNECT');
    expect(hasTestID('section-connected')).toBe(true);
    expect(hasTestID('section-available')).toBe(true);
    expect(screenMentions('Phone D')).toBe(true);
  });

  it('7/8. disconnecting C leaves D CONNECTED (UI isolation)', async () => {
    await renderScreen();
    await discover('Phone C', -40);
    await discover('Phone D', -50);

    await pressAction('Phone C');
    await emit('BLE_CONNECTED', { deviceId: 'Phone C', mtu: 512 });
    await pressAction('Phone D');
    await emit('BLE_CONNECTED', { deviceId: 'Phone D', mtu: 247 });

    // Simulate the native disconnect of C (as DISCONNECT on C would cause).
    await emit('BLE_DISCONNECTED', { deviceId: 'Phone C', reason: 'REMOTE' });

    // C no longer CONNECTED; D remains CONNECTED.
    expect(actionLabelOf('Phone C')).toBe('CONNECT');
    expect(actionLabelOf('Phone D')).toBe('DISCONNECT');
    expect(hasTestID('section-connected')).toBe(true);
    expect(screenMentions('Phone D')).toBe(true);
  });

  it('9/10. a peer CONNECTING does not disable other peers controls', async () => {
    await renderScreen();
    await discover('Phone C', -40);
    await discover('Phone D', -50);

    // D starts connecting and never finishes.
    await pressAction('Phone D');
    expect(screenMentions('CONNECTING')).toBe(true);
    const dBtn = actionButtonOf('Phone D');
    expect(dBtn).not.toBeNull();
    expect(dBtn.props.disabled).toBe(true); // its own spinner

    // C is fully usable while D is connecting.
    const cBtn = actionButtonOf('Phone C');
    expect(cBtn).not.toBeNull();
    expect(cBtn.props.disabled).toBe(false);
    expect(actionLabelOf('Phone C')).toBe('CONNECT');
  });

  it('11. per-peer MTU is displayed for each connected peer', async () => {
    await renderScreen();
    await discover('Phone C', -40);
    await discover('Phone D', -50);

    await pressAction('Phone C');
    await emit('BLE_CONNECTED', { deviceId: 'Phone C', mtu: 512 });
    await pressAction('Phone D');
    await emit('BLE_CONNECTED', { deviceId: 'Phone D', mtu: 23 });

    const text = allText();
    expect(text).toContain('512');
    expect(text).toContain('23');
  });

  it('12. per-peer role is displayed when available', async () => {
    await renderScreen();
    await discover('Phone C', -40);

    await pressAction('Phone C');
    await emit('BLE_CONNECTED', { deviceId: 'Phone C', mtu: 512 });

    // Client-initiated connect → CLIENT shown on the connected row.
    expect(screenMentions('CLIENT')).toBe(true);
  });

  it('13. a connection error does not clear other connected peers', async () => {
    await renderScreen();
    await discover('Phone C', -40);
    await discover('Phone D', -50);

    await pressAction('Phone C');
    await emit('BLE_CONNECTED', { deviceId: 'Phone C', mtu: 512 });
    await pressAction('Phone D');
    await emit('BLE_CONNECTED', { deviceId: 'Phone D', mtu: 247 });

    // A generic native connection error arrives.
    await emit('BLE_CONNECTION_ERROR', { code: 'WRITE_FAILED', message: 'timed out' });

    // Error text is shown, but both peers remain CONNECTED.
    expect(screenMentions('Connection error')).toBe(true);
    expect(actionLabelOf('Phone C')).toBe('DISCONNECT');
    expect(actionLabelOf('Phone D')).toBe('DISCONNECT');
    expect(hasTestID('section-connected')).toBe(true);
  });

  it('14. empty state still works', async () => {
    await renderScreen();
    expect(hasTestID('empty-state')).toBe(true);
    expect(hasTestID('section-connected')).toBe(false);
    expect(hasTestID('section-available')).toBe(false);
  });

  it('15. single-peer case remains clean and usable', async () => {
    await renderScreen();
    await discover('Phone C', -40);

    // Single available peer with a CONNECT action.
    expect(hasTestID('section-available')).toBe(true);
    expect(hasTestID('section-connected')).toBe(false);
    expect(actionLabelOf('Phone C')).toBe('CONNECT');

    // Connect and confirm.
    await pressAction('Phone C');
    await emit('BLE_CONNECTED', { deviceId: 'Phone C', mtu: 512 });

    expect(hasTestID('section-connected')).toBe(true);
    expect(hasTestID('section-available')).toBe(false);
    expect(actionLabelOf('Phone C')).toBe('DISCONNECT');
    expect(screenMentions('Phone C')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// V9E Step 10 — destination-aware voice routing (UI surface)
//
// The screen exposes a VOICE DESTINATION section backed by the shared
// dependency-free store (voiceDestinationStore.ts). Destinations are BITCHAT
// nodeIds — never Bluetooth deviceIds. Direct peers are labeled "(direct)",
// discovered-but-not-connected nodes "(mesh)".
// ─────────────────────────────────────────────────────────────────────────
describe('ConnectScreen — voice destination selector', () => {
  const NODE_X = '0x00000000000000aa'; // direct peer behind BLE "Phone C"
  const NODE_Z = '0x00000000000000cc'; // mesh-discovered, not connected
  const BROADCAST = '0x0000000000000000';

  beforeEach(() => {
    resetVoiceDestinationStore();
  });

  afterEach(() => {
    resetVoiceDestinationStore();
  });

  function destRowOf(nodeId: string): any {
    const matches = rendererRef.current!.root.findAll(
      (n: any) => n.props && n.props.testID === `dest-${nodeId}`,
    );
    return matches.length > 0 ? matches[0] : null;
  }

  function destRowText(nodeId: string): string {
    const row = destRowOf(nodeId);
    if (!row) return '<absent>';
    return allTextOf(row);
  }

  async function pressDest(nodeId: string): Promise<void> {
    const row = destRowOf(nodeId);
    expect(row).not.toBeNull();
    await act(async () => {
      row.props.onPress();
    });
  }

  it('16. destination section renders with explicit broadcast selected by default', async () => {
    await renderScreen();
    expect(hasTestID('section-destination')).toBe(true);
    // Broadcast row exists and is marked selected (✓) by default.
    expect(destRowOf(BROADCAST)).not.toBeNull();
    expect(destRowText(BROADCAST)).toContain('Broadcast');
    expect(destRowText(BROADCAST)).toContain('✓');
    expect(getVoiceDestinationNodeId()).toBe(BROADCAST);
  });

  it('17. pressing a destination selects it in the shared store and highlights the row', async () => {
    // Provide a destination list: one direct peer, one discovered mesh node.
    registerMeshDestinationsProvider(() => [
      { nodeId: NODE_X, direct: true, blePeerId: 'Phone C' },
      { nodeId: NODE_Z, direct: false },
    ]);
    await renderScreen();

    // Direct vs discovered are labeled distinctly.
    expect(destRowText(NODE_X)).toContain('(direct)');
    expect(destRowText(NODE_Z)).toContain('(mesh)');

    // Selecting the discovered (non-direct) node sets the store nodeId.
    await pressDest(NODE_Z);
    expect(getVoiceDestinationNodeId()).toBe(NODE_Z);
    expect(destRowText(NODE_Z)).toContain('✓');
    expect(destRowText(NODE_X)).not.toContain('✓');

    // Explicitly returning to broadcast works.
    await pressDest(BROADCAST);
    expect(getVoiceDestinationNodeId()).toBe(BROADCAST);
    expect(destRowText(BROADCAST)).toContain('✓');
  });
});
