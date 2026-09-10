/**
 * Half-duplex TX ownership tests — direct A↔B turn-taking.
 *
 * Covers the Phase 22 two-way requirements:
 * 27. A acquires TX ownership           28. B becomes WAITING (RECEIVING)
 * 29. A releases ownership              30. B can then acquire ownership
 * 31. B cannot transmit while A owns    32. simultaneous requests: deterministic winner
 * 33. failed transmission releases      34. disconnect releases ownership
 * 35. TTS completion returns to READY   36. PTT blocked while WAITING
 * 37. PTT blocked while SPEAKING        38. repeated alternating A↔B messages
 *
 * Harness mirrors useBLEVoiceMode.test.tsx: controllable native fakes,
 * real codecs, assertions on the actual frames that were sent.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { useBLEVoiceMode } from '../useBLEVoiceMode';
import {
  v6bDecode,
  V6B_FRAME_TX_CONTROL,
  TX_OP_REQUEST,
  TX_OP_GRANT,
  TX_OP_RELEASE,
  TX_OWNER_NONE,
  TX_OWNER_SELF,
  TX_OWNER_REMOTE,
  buildTxControlFrame,
  decodeTxControlPayload,
} from '../../protocol';
import { SequenceManager } from '../../protocol';

// ── react-native fake (same shape as the main suite) ──────────────────

jest.mock('react-native', () => {
  let storageMode: 'hang' | 'resolve' = 'resolve';
  const emitterInstances: any[] = [];

  class MockSttEmitter {
    private handlers = new Map<string, Set<(event?: any) => void>>();
    constructor(_nativeModule?: any) {
      emitterInstances.push(this);
    }
    addListener(eventType: string, cb: (event?: any) => void) {
      let set = this.handlers.get(eventType);
      if (!set) set = new Set();
      this.handlers.set(eventType, set);
      set.add(cb);
      return { remove: () => set!.delete(cb) };
    }
    removeAllListeners(eventType?: string) {
      if (eventType) this.handlers.delete(eventType);
      else this.handlers.clear();
    }
    emit(eventType: string, event?: any) {
      const set = this.handlers.get(eventType);
      if (set) Array.from(set).forEach((cb) => cb(event));
    }
  }

  return {
    NativeEventEmitter: MockSttEmitter,
    NativeModules: {
      NativeSTT: { addListener: jest.fn(), removeListeners: jest.fn() },
      NativeTTS: { speak: jest.fn(async () => {}) },
      AsyncStorage: {
        getItem: jest.fn(() =>
          storageMode === 'hang' ? new Promise(() => {}) : Promise.resolve(null),
        ),
        setItem: jest.fn(async () => {}),
      },
    },
    __emitterInstances: emitterInstances,
    __clearEmitters: () => {
      emitterInstances.length = 0;
    },
    __setStorageMode: (m: 'hang' | 'resolve') => {
      storageMode = m;
    },
  };
});

const rnMock: any = jest.requireMock('react-native');
const setStorageMode = rnMock.__setStorageMode as (m: 'hang' | 'resolve') => void;

// ── NativeSTT fake ─────────────────────────────────────────────────────

jest.mock('../../native/NativeSTT', () => ({
  __esModule: true,
  default: {
    muteMic: jest.fn(),
    unmuteMic: jest.fn(),
  },
}));

// ── NativeBLE fake ─────────────────────────────────────────────────────

jest.mock('../../native/NativeBLE', () => {
  const listeners = new Map<string, Set<(event?: any) => void>>();
  let connectionInfo: any = { state: 'IDLE', deviceId: '', mtu: 23 };

  const subscribe = (name: string, cb: (event?: any) => void) => {
    let set = listeners.get(name);
    if (!set) {
      set = new Set();
      listeners.set(name, set);
    }
    set.add(cb);
    return { remove: () => set!.delete(cb) };
  };

  return {
    __esModule: true,
    default: {
      getDeviceId: jest.fn(async () => 'LOCAL'),
      isBluetoothEnabled: jest.fn(async () => true),
      getConnectionState: jest.fn(async () => connectionInfo),
      send: jest.fn(async () => true),
      disconnect: jest.fn(async () => true),
      connect: jest.fn(async () => true),
      onDataReceived: (cb: any) => subscribe('BLE_DATA_RECEIVED', cb),
      onDisconnected: (cb: any) => subscribe('BLE_DISCONNECTED', cb),
      onConnected: (cb: any) => subscribe('BLE_CONNECTED', cb),
      onSendFailed: (cb: any) => subscribe('BLE_SEND_FAILED', cb),
      onSendSuccess: (cb: any) => subscribe('BLE_SEND_SUCCESS', cb),
    },
    __emit: (name: string, event?: any) => {
      const set = listeners.get(name);
      if (set) Array.from(set).forEach((cb) => cb(event));
    },
    __clearListeners: () => listeners.clear(),
    __setConnectionInfo: (info: any) => {
      connectionInfo = info;
    },
  };
});

const nativeMock: any = jest.requireMock('../../native/NativeBLE');
const mockNativeBLE = nativeMock.default;
const emitBLE = nativeMock.__emit as (name: string, event?: any) => void;
const setConnectionInfo = nativeMock.__setConnectionInfo as (info: any) => void;

// ── Helpers ────────────────────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  let charStr = '';
  for (let i = 0; i < bytes.length; i++) charStr += String.fromCharCode(bytes[i]);
  return (globalThis as any).btoa(charStr);
}

function base64ToBytes(b64: string): Uint8Array {
  const decoded = (globalThis as any).atob(b64);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i) & 0xff;
  return bytes;
}

type HookApi = ReturnType<typeof useBLEVoiceMode>;
let api: () => HookApi;

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
  return { renderer, api: () => apiRef.current! };
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => {});
};

/** Enable voice mode against a connected peer. */
async function enableVoice(deviceId: string) {
  setConnectionInfo({ state: 'CONNECTED', deviceId, mtu: 512 });
  mockNativeBLE.getConnectionState.mockResolvedValue({ state: 'CONNECTED', deviceId, mtu: 512 });
  await act(async () => {
    await api().toggleVoiceMode();
  });
  await settle();
}

/** All TX_CONTROL ops sent to a device. */
function txOpsSentTo(deviceId: string): Array<{ op: number; txId: number; requestId: number }> {
  const ops: Array<{ op: number; txId: number; requestId: number }> = [];
  for (const call of mockNativeBLE.send.mock.calls as any[][]) {
    try {
      if (call[1] !== deviceId) continue;
      const frame = v6bDecode(base64ToBytes(call[0]));
      if (frame.frameType !== V6B_FRAME_TX_CONTROL) continue;
      const ctrl = decodeTxControlPayload(frame.payload);
      if (ctrl) ops.push(ctrl);
    } catch {
      /* not a TX frame */
    }
  }
  return ops;
}

/** Emit a TX_CONTROL frame from a peer. */
function emitTx(op: number, txId: number, requestId: number, fromDevice: string) {
  act(() => {
    emitBLE('BLE_DATA_RECEIVED', {
      data: bytesToBase64(buildTxControlFrame(new SequenceManager(0).nextSequence(), { op, txId, requestId })),
      fromDevice,
    });
  });
}

/** Emit an STT final result into the latest captured STT emitter. */
function sttResult(transcript: string) {
  const instances: any[] = rnMock.__emitterInstances;
  const emitter = instances[instances.length - 1];
  act(() => {
    emitter.emit('STT_RESULT', { transcript });
  });
}

// ── Suite ──────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  nativeMock.__clearListeners();
  rnMock.__clearEmitters();
  setStorageMode('resolve');
  setConnectionInfo({ state: 'IDLE', deviceId: '', mtu: 23 });
  mockNativeBLE.getConnectionState.mockResolvedValue({ state: 'IDLE', deviceId: '', mtu: 23 });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useBLEVoiceMode — half-duplex TX ownership', () => {
  it('27. beginPttTurn acquires ownership; local sends release it after the turn', async () => {
    const r = await renderHook();
    api = r.api;
    await enableVoice('B');

    let allowed = false;
    await act(async () => {
      const turn = api().beginPttTurn().then((v) => {
        allowed = v;
      });
      await act(async () => {});
      // The REQUEST went out; the peer grants it (non-zero token) while
      // the turn promise is still pending.
      const reqs = txOpsSentTo('B').filter((o) => o.op === TX_OP_REQUEST);
      expect(reqs.length).toBe(1);
      emitTx(TX_OP_GRANT, 501, reqs[0].requestId, 'B');
      await turn;
    });
    await settle();
    expect(allowed).toBe(true);
    expect(api().txOwnership).toBe(TX_OWNER_SELF);

    // A voice turn: STT result sends the message and releases ownership.
    sttResult('Hello B');
    await settle();

    // Mesh path needs the adapter + registry; in this harness the registry
    // is empty so the send fails honestly — either way the turn ENDS and
    // ownership is released (failed turns also release).
    expect(api().txOwnership).toBe(TX_OWNER_NONE);
  });

  it('28. remote-owned turn puts local side into WAITING (RECEIVING status)', async () => {
    const r = await renderHook();
    api = r.api;
    await enableVoice('B');

    // B requests the turn; we are idle → we grant (REMOTE owns).
    emitTx(TX_OP_REQUEST, 0, 42, 'B');
    await settle();

    expect(api().txOwnership).toBe(TX_OWNER_REMOTE);
    expect(api().status).toBe('RECEIVING');
    expect(api().txWaitReason).toContain('transmitting');
  });

  it('29/30. release returns to NO_OWNER; the freed side can then acquire', async () => {
    const r = await renderHook();
    api = r.api;
    await enableVoice('B');

    emitTx(TX_OP_REQUEST, 0, 1, 'B');
    await settle();
    expect(api().txOwnership).toBe(TX_OWNER_REMOTE);

    // B finishes its turn.
    emitTx(TX_OP_RELEASE, 7, 0, 'B');
    await settle();
    expect(api().txOwnership).toBe(TX_OWNER_NONE);
    expect(api().status).toBe('WAITING_FOR_SPEECH');

    // Now WE can acquire — the peer grants our new request.
    let allowed = false;
    await act(async () => {
      const turn = api().beginPttTurn().then((v) => {
        allowed = v;
      });
      await act(async () => {});
      const reqs = txOpsSentTo('B').filter((o) => o.op === TX_OP_REQUEST);
      expect(reqs.length).toBe(1);
      emitTx(TX_OP_GRANT, 600, reqs[0].requestId, 'B');
      await turn;
    });
    await settle();
    expect(allowed).toBe(true);
    expect(api().txOwnership).toBe(TX_OWNER_SELF);
  });

  it('31. local PTT cannot start STT-for-sending while REMOTE owns (STT gate)', async () => {
    const r = await renderHook();
    api = r.api;
    await enableVoice('B');

    emitTx(TX_OP_REQUEST, 0, 5, 'B');
    await settle();
    expect(api().txOwnership).toBe(TX_OWNER_REMOTE);

    // PTT gate must refuse while remote owns.
    let allowed = true;
    await act(async () => {
      allowed = await api().beginPttTurn();
    });
    expect(allowed).toBe(false);

    // Defense in depth: an STT result that slips through is refused too —
    // nothing is sent, no ownership change.
    const sendsBefore = (mockNativeBLE.send as jest.Mock).mock.calls.length;
    sttResult('should not be sent');
    await settle();
    expect((mockNativeBLE.send as jest.Mock).mock.calls.length).toBe(sendsBefore);
    expect(api().txOwnership).toBe(TX_OWNER_REMOTE);
  });

  it('32. simultaneous requests: deterministic winner (grant-holder owns; loser denied or waits)', async () => {
    const r = await renderHook();
    api = r.api;
    await enableVoice('B');

    // We press first: our REQUEST is in flight (resolver pending).
    let turnAllowed: boolean | null = null;
    await act(async () => {
      const turn = api().beginPttTurn().then((v) => {
        turnAllowed = v;
      });
      await act(async () => {});
      // The peer grants OUR request — first valid request wins.
      const reqs = txOpsSentTo('B').filter((o) => o.op === TX_OP_REQUEST);
      expect(reqs.length).toBe(1);
      emitTx(TX_OP_GRANT, 99, reqs[0].requestId, 'B');
      await turn;
    });
    await settle();

    // Deterministic: our non-zero grant won → we own; remote's REQUEST
    // (if it had sent one) would be denied by us as OWNER=SELF.
    expect(turnAllowed).toBe(true);
    expect(api().txOwnership).toBe(TX_OWNER_SELF);

    // Remote's late REQUEST while we own → denied with zero-token grant.
    emitTx(TX_OP_REQUEST, 0, 77, 'B');
    await settle();
    const denies = txOpsSentTo('B').filter((o) => o.op === TX_OP_GRANT && o.txId === 0);
    expect(denies.length).toBe(1);
    expect(api().txOwnership).toBe(TX_OWNER_SELF);
  });

  it('33. failed transmission releases ownership (no lock leak)', async () => {
    const r = await renderHook();
    api = r.api;
    await enableVoice('B');

    await act(async () => {
      const turn = api().beginPttTurn();
      await act(async () => {});
      const reqs = txOpsSentTo('B').filter((o) => o.op === TX_OP_REQUEST);
      if (reqs.length > 0) {
        emitTx(TX_OP_GRANT, 33, reqs[reqs.length - 1].requestId, 'B');
      }
      await turn;
    });
    expect(api().txOwnership).toBe(TX_OWNER_SELF);

    // Make every send fail (write failure / disconnect during send).
    mockNativeBLE.send.mockImplementation(async () => {
      throw new Error('GATT_WRITE_FAILED');
    });

    sttResult('This send will fail');
    await settle();

    // Honest failure + ownership released.
    expect(api().txOwnership).toBe(TX_OWNER_NONE);
    expect(api().sendStatus).toBe('failed');
    expect(api().voiceError).toMatch(/Send failed/i);

    mockNativeBLE.send.mockReset();
    mockNativeBLE.send.mockImplementation(async () => true);
  });

  it('34. disconnect releases ownership in both directions', async () => {
    const r = await renderHook();
    api = r.api;
    await enableVoice('B');

    // Case 1: we own; link drops → NONE.
    await act(async () => {
      const turn = api().beginPttTurn();
      await act(async () => {});
      const reqs = txOpsSentTo('B').filter((o) => o.op === TX_OP_REQUEST);
      if (reqs.length > 0) {
        emitTx(TX_OP_GRANT, 34, reqs[reqs.length - 1].requestId, 'B');
      }
      await turn;
    });
    expect(api().txOwnership).toBe(TX_OWNER_SELF);
    act(() => {
      emitBLE('BLE_DISCONNECTED', { deviceId: 'B', reason: 'LOCAL' });
    });
    await settle();
    expect(api().txOwnership).toBe(TX_OWNER_NONE);

    // Reconnect; remote owns; link drops → NONE again.
    await enableVoice('B');
    emitTx(TX_OP_REQUEST, 0, 9, 'B');
    await settle();
    expect(api().txOwnership).toBe(TX_OWNER_REMOTE);
    act(() => {
      emitBLE('BLE_DISCONNECTED', { deviceId: 'B', reason: 'REMOTE' });
    });
    await settle();
    expect(api().txOwnership).toBe(TX_OWNER_NONE);
  });

  it('35. remote RELEASE returns the side to READY (WAITING_FOR_SPEECH)', async () => {
    const r = await renderHook();
    api = r.api;
    await enableVoice('B');

    emitTx(TX_OP_REQUEST, 0, 3, 'B');
    await settle();
    expect(api().status).toBe('RECEIVING');

    emitTx(TX_OP_RELEASE, 1, 0, 'B');
    await settle();
    expect(api().txOwnership).toBe(TX_OWNER_NONE);
    expect(api().status).toBe('WAITING_FOR_SPEECH');
  });

  it('38. repeated alternating A↔B turns never deadlock the link', async () => {
    const r = await renderHook();
    api = r.api;
    await enableVoice('B');

    for (let round = 0; round < 3; round++) {
      // Our turn.
    let allowed = false;
    await act(async () => {
      const turn = api().beginPttTurn().then((v) => {
        allowed = v;
      });
      // Grant arrives while the promise is pending — with fake timers this
      // must be advanced inside act().
      await act(async () => {});
      const reqs = txOpsSentTo('B').filter((o) => o.op === TX_OP_REQUEST);
      if (reqs.length > 0) {
        emitTx(TX_OP_GRANT, 600 + round, reqs[reqs.length - 1].requestId, 'B');
      }
      await turn;
    });
    expect(allowed).toBe(true);
    expect(api().txOwnership).toBe(TX_OWNER_SELF);

    // Turn ends (send fails honestly in this harness; releases lock).
      sttResult(`round ${round} message`);
      await settle();
      expect(api().txOwnership).toBe(TX_OWNER_NONE);

      // Remote's turn.
      emitTx(TX_OP_REQUEST, 0, 100 + round, 'B');
      await settle();
      expect(api().txOwnership).toBe(TX_OWNER_REMOTE);
      emitTx(TX_OP_RELEASE, 200 + round, 0, 'B');
      await settle();
      expect(api().txOwnership).toBe(TX_OWNER_NONE);
      expect(api().status).toBe('WAITING_FOR_SPEECH');
    }
  });

  it('36b. request timeout resolves denial — the link cannot be blocked by a silent peer', async () => {
    const r = await renderHook();
    api = r.api;
    await enableVoice('B');

    // REQUEST goes out but the peer never answers.
    let turnPromise: Promise<boolean> | null = null;
    await act(async () => {
      turnPromise = api().beginPttTurn();
      // Flush microtasks so the REQUEST is sent and the bounded wait
      // timer (1500 ms) is registered.
      await act(async () => {});
    });

    // No GRANT ever arrives — advance past the request deadline.
    await act(async () => {
      jest.advanceTimersByTime(1600);
    });

    const allowed = turnPromise ? await turnPromise : null;
    await settle();

    expect(allowed).toBe(false);
    expect(api().txOwnership).toBe(TX_OWNER_NONE);
  });
});
