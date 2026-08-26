export const NativeSTT = {
  startListening: async (language) => console.log('MOCK NativeSTT.startListening', language),
  stopListening: async () => console.log('MOCK NativeSTT.stopListening'),
  loadModel: async (language) => console.log('MOCK NativeSTT.loadModel', language),
  unloadModel: async () => console.log('MOCK NativeSTT.unloadModel'),
};

export const NativeTTS = {
  speak: async (text, language) => console.log('MOCK NativeTTS.speak', text, language),
  stop: async () => console.log('MOCK NativeTTS.stop'),
};

// NativeBLE is implemented in src/native/NativeBLE.ts
// Import from there: import NativeBLE from '../native/NativeBLE';
