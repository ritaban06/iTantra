import { NativeModules, NativeEventEmitter } from 'react-native';

const { NativeTTS } = NativeModules;
const ttsEmitter = new NativeEventEmitter(NativeTTS);

export default {
  speak: (text: string, language: string, isAlert: boolean = false): Promise<void> => {
    return NativeTTS.speak(text, language, isAlert);
  },
  stop: (): Promise<void> => {
    return NativeTTS.stop();
  },
  onStarted: (cb: (event: { text: string; language: string }) => void) => {
    return ttsEmitter.addListener('TTS_STARTED', cb);
  },
  onFinished: (cb: (event: { text: string; language: string; durationMs: number }) => void) => {
    return ttsEmitter.addListener('TTS_FINISHED', cb);
  },
  onError: (cb: (event: { error: string }) => void) => {
    return ttsEmitter.addListener('TTS_ERROR', cb);
  },
};
