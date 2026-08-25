import { NativeModules, NativeEventEmitter } from 'react-native';

const { NativeSTT } = NativeModules;
const emitter = new NativeEventEmitter(NativeSTT);

export default {
  startListening: (language) => NativeSTT.startListening(language),
  stopListening: () => NativeSTT.stopListening(),
  loadModel: (language) => NativeSTT.loadModel(language),
  unloadModel: () => NativeSTT.unloadModel(),
  isModelLoaded: (language) => NativeSTT.isModelLoaded(language),
  downloadModel: (language) => NativeSTT.downloadModel(language),
  onResult: (cb) => emitter.addListener('STT_RESULT', cb),
  onPartial: (cb) => emitter.addListener('STT_PARTIAL', cb),
  onError: (cb) => emitter.addListener('STT_ERROR', cb),
  onSpeechStart: (cb) => emitter.addListener('SPEECH_START', cb),
  onSpeechEnd: (cb) => emitter.addListener('SPEECH_END', cb),
  onDownloadProgress: (cb) => emitter.addListener('STT_DOWNLOAD_PROGRESS', cb),
};
