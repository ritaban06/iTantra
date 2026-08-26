import { useReducer, useEffect, useCallback, useRef } from 'react';
import { NativeEventEmitter, NativeModules } from 'react-native';
import { appReducer, AppState } from '../state/appReducer';
import { LocalLoopService } from '../services/LocalLoopService';

const { NativeSTT, NativeTTS } = NativeModules;

/**
 * Push-to-talk hook.
 *
 * When useDirectSTT is true (BLE Voice Mode ON):
 *   PTT → NativeSTT.startListening() / NativeSTT.stopListening()
 *   Final STT results are NOT spoken locally — they go through useBLEVoiceMode → BLE send.
 *
 * When useDirectSTT is false (normal mode):
 *   PTT → LocalLoopService.start() / LocalLoopService.stop()
 *   Final STT results are spoken locally via the native loop intercept.
 */
export function usePTT(useDirectSTT: boolean = false) {
  const [appState, dispatch] = useReducer(appReducer, { state: AppState.IDLE });
  const pttStartTimestamp = useRef<number | null>(null);
  const useDirectSTTRef = useRef(useDirectSTT);

  // Keep ref in sync so the effect callback always reads the latest value.
  useEffect(() => {
    useDirectSTTRef.current = useDirectSTT;
  }, [useDirectSTT]);

  useEffect(() => {
    const sttEmitter = new NativeEventEmitter(NativeSTT);
    const ttsEmitter = new NativeEventEmitter(NativeTTS);

    const subs = [
      ttsEmitter.addListener('TTS_STARTED', () => {
        dispatch({ type: 'TTS_STARTED' });
      }),
      ttsEmitter.addListener('TTS_FINISHED', () => {
        dispatch({ type: 'TTS_FINISHED' });
      }),
      sttEmitter.addListener('STT_ERROR', (evt) => {
        dispatch({ type: 'ERROR', error: evt.message });
      }),
    ];

    return () => subs.forEach(s => s.remove());
  }, []);

  const pressIn = useCallback(async (languageCode: string) => {
    pttStartTimestamp.current = Date.now();
    dispatch({ type: 'START_LISTENING' });
    try {
      if (useDirectSTTRef.current) {
        // BLE Voice Mode: use direct NativeSTT (no local TTS intercept).
        await NativeSTT.startListening(languageCode);
      } else {
        // Normal mode: use LocalLoopService (sets onFinalResultIntercept for local TTS).
        await LocalLoopService.start(languageCode);
      }
    } catch (e: any) {
      dispatch({ type: 'ERROR', error: e.message });
    }
  }, []);

  const pressOut = useCallback(async () => {
    dispatch({ type: 'STOP_LISTENING' });
    try {
      if (useDirectSTTRef.current) {
        // BLE Voice Mode: direct stop.
        await NativeSTT.stopListening();
      } else {
        // Normal mode: stop via LocalLoopService.
        await LocalLoopService.stop();
      }
    } catch (e: any) {
      dispatch({ type: 'ERROR', error: e.message });
    }
  }, []);

  return {
    appState: appState.state,
    error: appState.error,
    pressIn,
    pressOut,
  };
}
