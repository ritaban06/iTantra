/**
 * V9E Step 10 — Shared voice-destination store.
 *
 * Deliberately dependency-free (no React, no NativeBLE, no BITCHAT module
 * imports beyond a constant) so ANY screen/hook can read or set the voice
 * destination without pulling in the whole voice-mode stack.
 *
 * The store keeps the two identities separate:
 * - Bluetooth transport identity: deviceId
 * - BITCHAT network identity:   nodeId
 *
 * The logical voice destination is ALWAYS a BITCHAT nodeId (or broadcast),
 * never a Bluetooth deviceId.
 */

import { NODE_ID_BROADCAST } from '../BITCHAT/core/BitChatConstants';

/** The logical destination for voice-originated BITCHAT packets. */
export type VoiceDestination = string; // normalized BITCHAT NodeId or NODE_ID_BROADCAST

/**
 * A selectable mesh destination: a BITCHAT nodeId (logical network
 * identity) plus whether it is a directly connected BLE peer.
 */
export interface MeshDestination {
  /** Logical BITCHAT nodeId (never a Bluetooth deviceId). */
  nodeId: string;
  /** True when this node is a directly connected BLE peer. */
  direct: boolean;
  /** The BLE deviceId backing a direct peer (undefined for multi-hop nodes). */
  blePeerId?: string | null;
}

// ── Voice destination ─────────────────────────────────────────────────

let currentVoiceDestination: VoiceDestination = NODE_ID_BROADCAST;
const voiceDestinationListeners = new Set<(dest: VoiceDestination) => void>();

/** Read the current voice destination (nodeId or broadcast). */
export function getVoiceDestinationNodeId(): VoiceDestination {
  return currentVoiceDestination;
}

/** Set the voice destination for future voice-originated packets. */
export function setVoiceDestinationNodeId(destinationNodeId: VoiceDestination): void {
  currentVoiceDestination = destinationNodeId;
  voiceDestinationListeners.forEach((l) => l(currentVoiceDestination));
}

/** Subscribe to voice-destination changes; returns an unsubscribe fn. */
export function subscribeVoiceDestination(
  listener: (dest: VoiceDestination) => void,
): () => void {
  voiceDestinationListeners.add(listener);
  return () => {
    voiceDestinationListeners.delete(listener);
  };
}

// ── Mesh destinations ─────────────────────────────────────────────────

// The hook registers a provider bound to its adapter; screens subscribe to
// be notified when the peer/discovery set changes.
let meshDestinationsProvider: (() => MeshDestination[]) | null = null;
const meshDestinationsListeners = new Set<() => void>();

/** Register (or clear) the provider that builds the current destination list. */
export function registerMeshDestinationsProvider(fn: (() => MeshDestination[]) | null): void {
  meshDestinationsProvider = fn;
  meshDestinationsListeners.forEach((l) => l());
}

/** Get the current mesh destinations (direct peers + discovered nodes). */
export function getMeshDestinations(): MeshDestination[] {
  return meshDestinationsProvider ? meshDestinationsProvider() : [];
}

/** Subscribe to mesh-destination changes; returns an unsubscribe fn. */
export function subscribeMeshDestinations(listener: () => void): () => void {
  meshDestinationsListeners.add(listener);
  return () => {
    meshDestinationsListeners.delete(listener);
  };
}

/** Notify subscribers that the known peer/discovery set may have changed. */
export function notifyMeshDestinationsChanged(): void {
  meshDestinationsListeners.forEach((l) => l());
}

// ── Test helpers ──────────────────────────────────────────────────────

/** Reset the store to broadcast, clear listeners, and drop the provider. */
export function resetVoiceDestinationStore(): void {
  currentVoiceDestination = NODE_ID_BROADCAST;
  voiceDestinationListeners.clear();
  meshDestinationsProvider = null;
  meshDestinationsListeners.clear();
}