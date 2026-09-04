import { NativeModules, NativeEventEmitter } from 'react-native';

/**
 * EXPERIMENTAL — sherpa-onnx speech runtime (Android Speech Integration Gate).
 *
 * Thin wrapper over the NativeSherpa native module. NOT used by any production
 * speech path (NativeSTT / NativeTTS / useSTT / useTTS / useBLEVoiceMode are
 * untouched). This exists only so a colleague can exercise the experimental
 * sherpa-onnx engines on a real Android phone:
 *
 *  - en: streaming zipformer STT (partials + endpointing)
 *  - hi: OFFLINE NeMo-CTC IndicConformer STT (utterance-only, never streaming)
 *  - en/hi: MMS VITS TTS
 *  - Silero VAD
 *
 * All model files are packaged local assets — no runtime downloads.
 */

const { NativeSherpa } = NativeModules;
const sherpaEmitter = new NativeEventEmitter(NativeSherpa);

export interface SherpaStatus {
  sttStreaming: boolean;
  sttOffline: boolean;
  tts: boolean;
  vad: boolean;
}

export interface SherpaResult {
  text: string;
  language: string;
  isStreaming?: boolean;
}

export interface VadSegment {
  startSample: number;
  numSamples: number;
}

export default {
  /** Load the bundled STT model for `language` ('en' = streaming, 'hi' = offline). */
  loadSTT: (language: string): Promise<{ language: string; isStreaming: boolean }> =>
    NativeSherpa.loadSTT(language),

  /** Start live 16 kHz mono PCM16 microphone capture (streaming models only). */
  startListening: (): Promise<void> => NativeSherpa.startListening(),

  /** Stop capture and resolve with the final streaming transcript. */
  stopListening: (): Promise<{ text: string; language: string }> =>
    NativeSherpa.stopListening(),

  /** Offline recognition of a base64 16 kHz mono PCM16 buffer (Hindi). */
  recognizeOffline: (base64Pcm: string): Promise<{ text: string; language: string }> =>
    NativeSherpa.recognizeOffline(base64Pcm),

  /** Capture `maxDurationMs` of mic audio (1–30 s), then run offline recognition. */
  captureOfflineUtterance: (
    maxDurationMs: number,
  ): Promise<{ text: string; language: string; pcmBytes: number }> =>
    NativeSherpa.captureOfflineUtterance(maxDurationMs),

  /** Load the bundled MMS VITS TTS model for `language` ('en' | 'hi'). */
  loadTTS: (language: string): Promise<{ language: string }> =>
    NativeSherpa.loadTTS(language),

  /** Synthesize `text` with the `language` model and play it through the speaker. */
  speak: (text: string, language: string): Promise<{ durationMs: number; language: string }> =>
    NativeSherpa.speak(text, language),

  /** Stop current TTS playback. */
  stopSpeaking: (): Promise<void> => NativeSherpa.stopSpeaking(),

  /** Load the bundled Silero VAD model. */
  loadVAD: (): Promise<void> => NativeSherpa.loadVAD(),

  /** Feed a base64 16 kHz mono PCM16 chunk; resolves with speech segments found. */
  feedVAD: (base64Pcm: string): Promise<VadSegment[]> => NativeSherpa.feedVAD(base64Pcm),

  /** Capture `durationMs` of mic audio through Silero VAD; resolves with segments. */
  runVadTest: (durationMs: number): Promise<VadSegment[]> => NativeSherpa.runVadTest(durationMs),

  /** Current model/runtime load state. */
  getStatus: (): Promise<SherpaStatus> => NativeSherpa.isLoaded(),

  /** Release every experimental sherpa resource (STT + TTS + VAD + capture). */
  releaseAll: (): Promise<void> => NativeSherpa.releaseAll(),

  // ── Events (SHERPA_-prefixed; independent of production contracts) ──

  onPartial: (cb: (event: { text: string }) => void) =>
    sherpaEmitter.addListener('SHERPA_PARTIAL', cb),

  onResult: (cb: (event: SherpaResult) => void) =>
    sherpaEmitter.addListener('SHERPA_RESULT', cb),

  onError: (cb: (event: { code: string; message: string }) => void) =>
    sherpaEmitter.addListener('SHERPA_ERROR', cb),
};