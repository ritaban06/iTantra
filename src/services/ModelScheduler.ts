import { NativeModules } from 'react-native';

const { NativeSTT, NativeTTS } = NativeModules;

/**
 * Simplified scheduler for Milestone 4 prioritizing sequential model loading.
 */
export class ModelScheduler {
  static async loadModelsForLanguage(language: string) {
    // 1. Load STT
    const isSTTLoaded = await NativeSTT.isModelLoaded(language);
    if (!isSTTLoaded) {
      await NativeSTT.loadModel(language);
    }

    // 2. Load TTS model implicitly if needed, or if TTS has an explicit load, call it.
    // TTSModule currently manages its own ModelManager.getEngine lazily.
  }

  static async unloadModels() {
    await NativeSTT.unloadModel();
    await NativeTTS.stop();
  }
}
