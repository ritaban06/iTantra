import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  getChatSnapshot,
  getConversation,
  isChatTransportReady,
  sendChatMessage,
  subscribeChatMessages,
  type ChatMessage,
} from '../messages';
import {
  getMeshDestinations,
  subscribeMeshDestinations,
  type MeshDestination,
} from '../hooks/voiceDestinationStore';
import { NODE_ID_BROADCAST } from '../BITCHAT';

function shortNodeId(nodeId: string): string {
  return nodeId.length > 14 ? `${nodeId.slice(0, 8)}…${nodeId.slice(-4)}` : nodeId;
}

function formatTime(time: number): string {
  return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function ChatScreen() {
  // useSyncExternalStore closes the render-to-subscription window: React
  // rechecks getChatSnapshot after subscribing and rerenders if a message
  // arrived during mount.
  const chatSnapshot = useSyncExternalStore(
    subscribeChatMessages,
    getChatSnapshot,
    getChatSnapshot,
  );
  const [destinations, setDestinations] = useState<MeshDestination[]>(getMeshDestinations());
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribeDestinations = subscribeMeshDestinations(() => {
      setDestinations(getMeshDestinations());
    });
    return () => {
      unsubscribeDestinations();
    };
  }, []);

  const conversationNodeIds = useMemo(() => {
    const ids = new Set(chatSnapshot.messages.map(message => message.conversationNodeId));
    return Array.from(ids);
  }, [chatSnapshot]);

  const peers = useMemo(() => {
    // Typed chat is deliberately one-to-one. Broadcast remains a transport
    // capability for voice/control traffic, never a selectable chat peer.
    const known = new Map(destinations
      .filter(destination => destination.nodeId !== NODE_ID_BROADCAST)
      .map(destination => [destination.nodeId, destination]));
    conversationNodeIds.forEach(nodeId => {
      if (!known.has(nodeId)) known.set(nodeId, { nodeId, direct: false });
    });
    return Array.from(known.values()).sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  }, [destinations, conversationNodeIds]);

  const conversation = selectedNodeId ? getConversation(selectedNodeId) : [];
  const routeReady = selectedNodeId ? isChatTransportReady(selectedNodeId) : false;

  const selectConversation = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    setSendError(null);
  };

  const send = async () => {
    if (!selectedNodeId || !draft.trim()) return;
    const text = draft;
    setDraft('');
    setSendError(null);
    try {
      await sendChatMessage(selectedNodeId, text);
    } catch (error: any) {
      setSendError(error?.message ?? 'Message could not be sent');
    }
  };

  if (!selectedNodeId) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.title}>Messages</Text>
        <Text style={styles.subtitle}>Choose a logical mesh node to start an offline conversation.</Text>
        <FlatList
          data={peers}
          keyExtractor={item => item.nodeId}
          contentContainerStyle={styles.peerList}
          ListEmptyComponent={<Text style={styles.empty}>No mesh peers are known yet.</Text>}
          renderItem={({ item }) => {
            const latest = getConversation(item.nodeId).at(-1);
            return (
              <TouchableOpacity
                testID={`chat-peer-${item.nodeId}`}
                style={styles.peerRow}
                onPress={() => selectConversation(item.nodeId)}
              >
                <View>
                  <Text style={styles.peerName}>{shortNodeId(item.nodeId)}</Text>
                  <Text style={styles.peerMeta}>{item.direct ? 'Direct peer' : 'Mesh peer'}</Text>
                </View>
                {latest ? <Text style={styles.preview} numberOfLines={1}>{latest.text}</Text> : null}
              </TouchableOpacity>
            );
          }}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <View style={styles.header}>
        <TouchableOpacity testID="chat-back" onPress={() => setSelectedNodeId(null)}>
          <Text style={styles.back}>‹ Peers</Text>
        </TouchableOpacity>
        <View>
          <Text style={styles.peerName}>{shortNodeId(selectedNodeId)}</Text>
          <Text style={[styles.route, routeReady ? styles.routeReady : styles.routeOffline]}>
            {routeReady ? 'Mesh route ready' : 'Offline — sending will fail'}
          </Text>
        </View>
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <FlatList
          data={conversation}
          keyExtractor={item => `${item.direction}:${item.senderNodeId}:${item.id}`}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => <MessageBubble item={item} />}
        />
        {sendError ? <Text style={styles.error}>{sendError}</Text> : null}
        <View style={styles.composer}>
          <TextInput
            testID="chat-input"
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder="Write a message"
            placeholderTextColor="#8e8e93"
            multiline
          />
          <TouchableOpacity
            testID="chat-send"
            style={[styles.send, (!draft.trim() || !routeReady) && styles.sendDisabled]}
            disabled={!draft.trim() || !routeReady}
            onPress={send}
          >
            <Text style={styles.sendText}>Send</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function MessageBubble({ item }: { item: ChatMessage }) {
  const mine = item.direction === 'outgoing';
  return (
    <View style={[styles.messageBubble, mine ? styles.myMessage : styles.theirMessage]}>
      {!mine ? <Text style={styles.sender}>{shortNodeId(item.senderNodeId)}</Text> : null}
      <Text style={[styles.messageText, mine && styles.myMessageText]}>{item.text}</Text>
      <Text style={[styles.time, mine && styles.myTime]}>{formatTime(item.time)} · {item.status}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0c' },
  flex: { flex: 1 },
  title: { color: '#fff', fontSize: 24, fontWeight: '700', paddingHorizontal: 18, paddingTop: 20 },
  subtitle: { color: '#8e8e93', paddingHorizontal: 18, paddingTop: 8, paddingBottom: 12 },
  peerList: { padding: 12 },
  peerRow: { backgroundColor: '#1c1c1e', borderRadius: 12, marginBottom: 10, padding: 14 },
  peerName: { color: '#fff', fontSize: 16, fontWeight: '700' },
  peerMeta: { color: '#00e676', fontSize: 12, marginTop: 4 },
  preview: { color: '#8e8e93', marginTop: 8 },
  empty: { color: '#8e8e93', textAlign: 'center', marginTop: 48 },
  header: { alignItems: 'center', borderBottomColor: '#2c2c2e', borderBottomWidth: 1, flexDirection: 'row', gap: 16, padding: 14 },
  back: { color: '#00e676', fontSize: 16 },
  route: { fontSize: 12, marginTop: 3 },
  routeReady: { color: '#00e676' },
  routeOffline: { color: '#ff9f0a' },
  list: { padding: 15 },
  messageBubble: { borderRadius: 18, marginBottom: 12, maxWidth: '82%', padding: 13 },
  myMessage: { alignSelf: 'flex-end', backgroundColor: '#00a95c', borderBottomRightRadius: 4 },
  theirMessage: { alignSelf: 'flex-start', backgroundColor: '#1c1c1e', borderBottomLeftRadius: 4 },
  sender: { color: '#8e8e93', fontSize: 11, fontWeight: '700', marginBottom: 4 },
  messageText: { color: '#fff', fontSize: 16, lineHeight: 21 },
  myMessageText: { color: '#061b10' },
  time: { alignSelf: 'flex-end', color: '#8e8e93', fontSize: 10, marginTop: 7 },
  myTime: { color: 'rgba(6,27,16,0.7)' },
  error: { color: '#ff453a', paddingHorizontal: 15, paddingBottom: 5 },
  composer: { alignItems: 'flex-end', borderTopColor: '#2c2c2e', borderTopWidth: 1, flexDirection: 'row', padding: 10 },
  input: { backgroundColor: '#1c1c1e', borderRadius: 18, color: '#fff', flex: 1, maxHeight: 110, paddingHorizontal: 14, paddingVertical: 10 },
  send: { backgroundColor: '#00e676', borderRadius: 18, marginLeft: 8, paddingHorizontal: 15, paddingVertical: 11 },
  sendDisabled: { opacity: 0.4 },
  sendText: { color: '#061b10', fontWeight: '700' },
});
