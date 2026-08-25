import { NativeModules, NativeEventEmitter } from 'react-native';

const { NativeLocalLoop } = NativeModules;

export class LocalLoopService {
  static async start(language: string) {
    if (!NativeLocalLoop) {
      console.warn("NativeLocalLoop module not found.");
      return;
    }
    return NativeLocalLoop.startLoop(language);
  }

  static async stop() {
    if (!NativeLocalLoop) {
      return;
    }
    return NativeLocalLoop.stopLoop();
  }
}
