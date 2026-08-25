import { useState, useEffect, useCallback } from 'react';
import NativeSTT from '../native/NativeSTT';

export const useSTT = () => {
  const [transcript, setTranscript] = useState('');
  const [partial, setPartial] = useState('');
  const [confidence, setConfidence] = useState(1.0);
  const [isListening, setIsListening] = useState(false);
  const [isModelLoaded, setIsModelLoaded] = useState(false);
  const [error, setError] = useState(null);
  const [isSpeechActive, setIsSpeechActive] = useState(false);

  useEffect(() => {
    const subs = [
      NativeSTT.onResult((res) => {
        setTranscript(res.transcript);
        setConfidence(res.confidence);
        setPartial('');
      }),
      NativeSTT.onPartial((res) => {
        setPartial(res.partial);
      }),
      NativeSTT.onError((err) => {
        setError(err.message);
        setIsListening(false);
      }),
      NativeSTT.onSpeechStart(() => {
        setIsSpeechActive(true);
      }),
      NativeSTT.onSpeechEnd(() => {
        setIsSpeechActive(false);
      })
    ];

    return () => {
      subs.forEach((sub) => sub.remove());
    };
  }, []);

  const loadModel = useCallback(async (language) => {
    try {
      setError(null);
      await NativeSTT.loadModel(language);
      setIsModelLoaded(true);
    } catch (err) {
      setError(err.message);
      setIsModelLoaded(false);
    }
  }, []);

  const startListening = useCallback(async (language) => {
    try {
      setError(null);
      setTranscript('');
      setPartial('');
      await NativeSTT.startListening(language);
      setIsListening(true);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  const stopListening = useCallback(async () => {
    try {
      await NativeSTT.stopListening();
      setIsListening(false);
      setIsSpeechActive(false);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  return {
    transcript,
    partial,
    confidence,
    isListening,
    isModelLoaded,
    error,
    isSpeechActive,
    loadModel,
    startListening,
    stopListening
  };
};
