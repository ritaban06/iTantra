/**
 * @format
 *
 * App smoke-render test. The native wrapper modules (NativeSTT/NativeTTS/
 * NativeBLE/NativeSherpa) construct a NativeEventEmitter at module scope,
 * which throws under Jest when the real native module is absent
 * (`new NativeEventEmitter()` requires a non-null argument). They are
 * replaced here with inert fakes; this test only verifies that the full
 * app tree renders, not native behavior.
 */

jest.mock('../src/native/NativeSTT', () => {
  const listener = () => ({ remove: () => {} });
  return {
    __esModule: true,
    default: {
      startListening: jest.fn(async () => {}),
      stopListening: jest.fn(async () => {}),
      loadModel: jest.fn(async () => {}),
      unloadModel: jest.fn(async () => {}),
      isModelLoaded: jest.fn(async () => false),
      downloadModel: jest.fn(async () => {}),
      cancelDownload: jest.fn(() => {}),
      muteMic: jest.fn(() => {}),
      unmuteMic: jest.fn(() => {}),
      onResult: listener,
      onPartial: listener,
      onError: listener,
      onSpeechStart: listener,
      onSpeechEnd: listener,
      onDownloadProgress: listener,
    },
  };
});

jest.mock('../src/native/NativeTTS', () => {
  const listener = () => ({ remove: () => {} });
  return {
    __esModule: true,
    default: {
      speak: jest.fn(async () => {}),
      stop: jest.fn(async () => {}),
      onStarted: listener,
      onFinished: listener,
      onError: listener,
    },
  };
});

jest.mock('../src/native/NativeBLE', () => {
  const listener = () => ({ remove: () => {} });
  return {
    __esModule: true,
    default: {
      startScan: jest.fn(async () => {}),
      stopScan: jest.fn(async () => {}),
      startAdvertising: jest.fn(async () => {}),
      stopAdvertising: jest.fn(async () => {}),
      connect: jest.fn(async () => {}),
      disconnect: jest.fn(async () => {}),
      send: jest.fn(async () => true),
      getConnectionState: jest.fn(async () => 'DISCONNECTED'),
      onDeviceFound: listener,
      onScanError: listener,
      onAdvertisingStarted: listener,
      onConnecting: listener,
      onConnected: listener,
      onDisconnected: listener,
      onDataReceived: listener,
      onError: listener,
      onMtuChanged: listener,
    },
  };
});

jest.mock('../src/native/NativeSherpa', () => {
  const listener = () => ({ remove: () => {} });
  const make = () => jest.fn(async () => {});
  return {
    __esModule: true,
    default: {
      getStatus: make,
      loadSTT: make,
      unloadSTT: make,
      startListening: make,
      stopListening: make,
      loadTTS: make,
      unloadTTS: make,
      speak: make,
      stopSpeaking: make,
      startVAD: make,
      stopVAD: make,
      onStatus: listener,
      onSTTPartial: listener,
      onSTTResult: listener,
      onSTTError: listener,
      onTTSAudio: listener,
      onTTSError: listener,
      onSpeechSegment: listener,
      onVADEvent: listener,
    },
  };
});

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';

test('renders correctly', async () => {
  await ReactTestRenderer.act(() => {
    ReactTestRenderer.create(<App />);
  });
});
