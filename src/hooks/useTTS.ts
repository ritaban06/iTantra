import { useState, useEffect } from 'react';
import NativeTTS from '../native/NativeTTS';

type TTSState = 'IDLE' | 'SYNTHESIZING' | 'PLAYING' | 'DONE';

export const useTTS = () => {
  const [ttsState, setTtsState] = useState<TTSState>('IDLE');
  const [lastRTF, setLastRTF] = useState<number | null>(null);

  useEffect(() => {
    const startedSub = NativeTTS.onStarted(() => {
      setTtsState('PLAYING');
    });
    
    const finishedSub = NativeTTS.onFinished((event) => {
      setTtsState('DONE');
      // Simple RTF approximation for now
      setLastRTF(event.durationMs); 
      setTimeout(() => setTtsState('IDLE'), 500);
    });

    const errorSub = NativeTTS.onError((e) => {
      console.error('TTS Error', e);
      setTtsState('IDLE');
    });

    return () => {
      startedSub.remove();
      finishedSub.remove();
      errorSub.remove();
    };
  }, []);

  const speak = async (text: string, language: string, isAlert: boolean = false) => {
    try {
      setTtsState('SYNTHESIZING');
      await NativeTTS.speak(text, language, isAlert);
    } catch (e) {
      console.error('Failed to speak:', e);
      setTtsState('IDLE');
    }
  };

  const stop = async () => {
    await NativeTTS.stop();
    setTtsState('IDLE');
  };

  return { ttsState, isSpeaking: ttsState === 'PLAYING', speak, stop, lastRTF };
};
