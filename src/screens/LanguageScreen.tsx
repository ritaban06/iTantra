import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, FlatList } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLanguage } from '../state/LanguageContext';

const LANGUAGES = [
  'English', 'Hindi', 'Bengali', 'Gujarati', 'Marathi',
  'Kannada', 'Malayalam', 'Tamil', 'Telugu', 'Odia'
];

export default function LanguageScreen() {
  const { languageName, setLanguage } = useLanguage();

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
          >
            <Text style={[styles.langText, languageName === item && styles.selectedText]}>{item}</Text>
            {languageName === item && <Text style={styles.check}>✓</Text>}
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
  langCard: { padding: 18, backgroundColor: '#1c1c1e', borderRadius: 12, marginBottom: 10, flexDirection: 'row', justifyContent: 'space-between', borderWidth: 1, borderColor: '#2c2c2e' },
  selectedCard: { borderColor: '#00e676', backgroundColor: '#002513' },
  langText: { color: '#fff', fontSize: 18 },
  selectedText: { color: '#00e676', fontWeight: 'bold' },
  check: { color: '#00e676', fontSize: 20, fontWeight: 'bold' }
});
