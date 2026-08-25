import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, FlatList, NativeModules, NativeEventEmitter, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLanguage, LANGUAGE_CODES } from '../state/LanguageContext';

const { NativeSTT } = NativeModules;

const LANGUAGES = [
  'English', 'Hindi', 'Bengali', 'Gujarati', 'Marathi',
  'Kannada', 'Malayalam', 'Tamil', 'Telugu', 'Odia'
];

export default function LanguageScreen() {
  const { languageName, setLanguage } = useLanguage();
  const [downloadStatus, setDownloadStatus] = useState<Record<string, boolean>>({});
  const [downloadProgress, setDownloadProgress] = useState<Record<string, number>>({});
  const [isDownloading, setIsDownloading] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const fetchStatuses = async () => {
      const statuses: Record<string, boolean> = {};
      for (const lang of LANGUAGES) {
        if (lang === 'English') {
          statuses[lang] = true;
        } else {
          try {
            const isDownloaded = await NativeSTT.isModelDownloaded(LANGUAGE_CODES[lang]);
            statuses[lang] = isDownloaded;
          } catch (e) {
            console.error(e);
          }
        }
      }
      setDownloadStatus(statuses);
    };

    fetchStatuses();

    const sttEmitter = new NativeEventEmitter(NativeSTT);
    const sub = sttEmitter.addListener('STT_DOWNLOAD_PROGRESS', (event: { language: string, progress: number }) => {
      const langName = Object.keys(LANGUAGE_CODES).find(key => LANGUAGE_CODES[key] === event.language);
      if (langName) {
        setDownloadProgress(prev => ({ ...prev, [langName]: event.progress }));
        if (event.progress === 100) {
          setIsDownloading(prev => ({ ...prev, [langName]: false }));
          setDownloadStatus(prev => ({ ...prev, [langName]: true }));
        }
      }
    });

    return () => sub.remove();
  }, []);

  const handleDownload = async (lang: string) => {
    try {
      setIsDownloading(prev => ({ ...prev, [lang]: true }));
      setDownloadProgress(prev => ({ ...prev, [lang]: 0 }));
      await NativeSTT.downloadModel(LANGUAGE_CODES[lang]);
      // Download completes, STT_DOWNLOAD_PROGRESS will hit 100 or promise resolves
      setDownloadStatus(prev => ({ ...prev, [lang]: true }));
      setIsDownloading(prev => ({ ...prev, [lang]: false }));
    } catch (e) {
      console.error(e);
      setIsDownloading(prev => ({ ...prev, [lang]: false }));
    }
  };

  const handleDelete = async (lang: string) => {
    if (lang === 'English') return; // Cannot delete pre-installed
    try {
      const deleted = await NativeSTT.deleteModel(LANGUAGE_CODES[lang]);
      if (deleted) {
        setDownloadStatus(prev => ({ ...prev, [lang]: false }));
      }
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>Select Active Language</Text>
      <Text style={styles.subtitle}>Models for other languages will be downloaded as needed.</Text>

      <FlatList
        data={LANGUAGES}
        keyExtractor={item => item}
        renderItem={({ item }: { item: any }) => (
          <TouchableOpacity 
            style={[styles.langCard, languageName === item && styles.selectedCard]}
            onPress={() => setLanguage(item)}
            disabled={!downloadStatus[item]}
          >
            <View style={styles.langInfo}>
              <Text style={[styles.langText, languageName === item && styles.selectedText]}>{item}</Text>
              {languageName === item && <Text style={styles.check}>✓</Text>}
            </View>
            <View style={styles.actions}>
              {item !== 'English' && (
                <>
                  {isDownloading[item] ? (
                    <View style={styles.progressContainer}>
                      <ActivityIndicator size="small" color="#00e676" />
                      <Text style={styles.progressText}>{downloadProgress[item] || 0}%</Text>
                    </View>
                  ) : downloadStatus[item] ? (
                    <TouchableOpacity onPress={() => handleDelete(item)} style={styles.actionBtn}>
                      <Text style={styles.deleteIcon}>🗑️</Text>
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity onPress={() => handleDownload(item)} style={styles.actionBtn}>
                      <Text style={styles.downloadIcon}>⬇️</Text>
                    </TouchableOpacity>
                  )}
                </>
              )}
            </View>
          </TouchableOpacity>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0c', padding: 20 },
  title: { color: '#fff', fontSize: 24, fontWeight: 'bold', marginBottom: 5 },
  subtitle: { color: '#8e8e93', marginBottom: 20 },
  langCard: { padding: 18, backgroundColor: '#1c1c1e', borderRadius: 12, marginBottom: 10, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderWidth: 1, borderColor: '#2c2c2e' },
  selectedCard: { borderColor: '#00e676', backgroundColor: '#002513' },
  langInfo: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  langText: { color: '#fff', fontSize: 18, marginRight: 10 },
  selectedText: { color: '#00e676', fontWeight: 'bold' },
  check: { color: '#00e676', fontSize: 20, fontWeight: 'bold' },
  actions: { flexDirection: 'row', alignItems: 'center' },
  actionBtn: { padding: 8, backgroundColor: '#2c2c2e', borderRadius: 8 },
  deleteIcon: { fontSize: 16 },
  downloadIcon: { fontSize: 16 },
  progressContainer: { flexDirection: 'row', alignItems: 'center' },
  progressText: { color: '#00e676', fontSize: 12, marginLeft: 5, width: 35 }
});
