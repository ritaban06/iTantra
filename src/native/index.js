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

export const NativeBLE = {
  startScanning: async () => console.log('MOCK NativeBLE.startScanning'),
  stopScanning: async () => console.log('MOCK NativeBLE.stopScanning'),
  startAdvertising: async () => console.log('MOCK NativeBLE.startAdvertising'),
  connect: async (deviceId) => console.log('MOCK NativeBLE.connect', deviceId),
  disconnect: async () => console.log('MOCK NativeBLE.disconnect'),
  send: async (data) => console.log('MOCK NativeBLE.send', data),
};
