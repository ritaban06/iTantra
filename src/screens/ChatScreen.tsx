import React from 'react';
import { View, Text, StyleSheet, FlatList } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const MOCK_MESSAGES = [
  { id: '1', text: 'Hello, are you there?', type: 'NORMAL', sender: 'ITN-B291', isMe: false, time: '10:42 AM' },
  { id: '2', text: 'Yes, I can hear you.', type: 'NORMAL', sender: 'ITN-A7F3', isMe: true, time: '10:43 AM' },
  { id: '3', text: 'Flood water entering shelter three. Evacuate.', type: 'ALERT', sender: 'ITN-C903', isMe: false, time: '10:45 AM' },
];

export default function ChatScreen() {
  const renderItem = ({ item }: { item: any }) => {
    const isAlert = item.type === 'ALERT';
    
    return (
      <View style={[
        styles.messageBubble, 
        item.isMe ? styles.myMessage : styles.theirMessage,
        isAlert && styles.alertMessage
      ]}>
        {!item.isMe && <Text style={styles.sender}>{item.sender}</Text>}
        <Text style={[styles.messageText, isAlert && styles.alertText]}>{item.text}</Text>
        <Text style={styles.time}>{item.time}</Text>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        data={MOCK_MESSAGES}
        keyExtractor={item => item.id}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0c',
  },
  list: {
    padding: 15,
  },
  messageBubble: {
    maxWidth: '80%',
    padding: 15,
    borderRadius: 18,
    marginBottom: 15,
  },
  myMessage: {
    alignSelf: 'flex-end',
    backgroundColor: '#00e676',
    borderBottomRightRadius: 4,
  },
  theirMessage: {
    alignSelf: 'flex-start',
    backgroundColor: '#1c1c1e',
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: '#2c2c2e',
  },
  alertMessage: {
    backgroundColor: '#ff3b30',
    borderColor: '#ff3b30',
  },
  sender: {
    fontSize: 12,
    color: '#8e8e93',
    marginBottom: 4,
    fontWeight: 'bold',
  },
  messageText: {
    fontSize: 16,
    color: '#fff',
    lineHeight: 22,
  },
  alertText: {
    color: '#fff',
    fontWeight: 'bold',
  },
  time: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.5)',
    marginTop: 8,
    alignSelf: 'flex-end',
  }
});
