import { useReducer, useEffect, useCallback, useRef } from 'react';
import { NativeEventEmitter, NativeModules } from 'react-native';
import { appReducer, AppState } from '../state/appReducer';
import { LocalLoopService } from '../services/LocalLoopService';

const { NativeSTT, NativeTTS } = NativeModules;

export function usePTT() {
  const [appState, dispatch] = useReducer(appReducer, { state: AppState.IDLE });
  const pttStartTimestamp = useRef<number | null>(null);

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
      await LocalLoopService.start(languageCode);
    } catch (e: any) {
      dispatch({ type: 'ERROR', error: e.message });
    }
  }, []);

  const pressOut = useCallback(async () => {
    dispatch({ type: 'STOP_LISTENING' });
    try {
      await LocalLoopService.stop();
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
