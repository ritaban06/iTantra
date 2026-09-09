/**
 * V9C BitChat Node Identity Store
 *
 * Generates and persists a stable local BITCHAT node ID.
 * Each iTantra installation gets one identity for its lifetime.
 *
 * Identity is a UInt64 value generated randomly on first access,
 * then persisted via the injected storage abstraction.
 *
 * The storage abstraction is injectable so this can later be
 * backed by AsyncStorage, SecureStore, or any other persistence layer.
 */

import { normalizeNodeId } from './core/BitChatPacket';
import type { NodeId } from './core/BitChatTypes';

/**
 * Simple key-value storage abstraction.
 * Implementations could use AsyncStorage, SecureStore, etc.
 */
export interface StorageBackend {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

const STORAGE_KEY = 'bitchat_node_id';

/**
 * Generate a random UInt64 node ID.
 * Uses crypto.getRandomValues if available, otherwise Math.random.
 */
function generateRandomNodeId(): NodeId {
  let randomBytes: Uint8Array;
  const g = globalThis as Record<string, unknown>;
  const c = g.crypto as { getRandomValues?: (arr: Uint8Array) => void } | undefined;
  if (c?.getRandomValues) {
    randomBytes = new Uint8Array(8);
    c.getRandomValues(randomBytes);
  } else {
    // Fallback: not cryptographically secure, but acceptable for node IDs
    randomBytes = new Uint8Array(8);
    for (let i = 0; i < 8; i++) {
      randomBytes[i] = Math.floor(Math.random() * 256);
    }
  }

  let value = BigInt(0);
  for (let i = 0; i < 8; i++) {
    value = (value << BigInt(8)) | BigInt(randomBytes[i]);
  }

  // Ensure non-zero (extremely unlikely but defensive)
  if (value === BigInt(0)) {
    value = BigInt(1);
  }

  return normalizeNodeId(value);
}

export class NodeIdStore {
  private cachedNodeId: NodeId | null = null;
  private readonly storage: StorageBackend;

  constructor(storage: StorageBackend) {
    this.storage = storage;
  }

  /**
   * Get the local node ID. Loads from storage if cached value is null.
   * Generates and persists a new one if none exists.
   */
  async getLocalNodeId(): Promise<NodeId> {
    if (this.cachedNodeId) {
      return this.cachedNodeId;
    }

    const stored = await this.storage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        this.cachedNodeId = normalizeNodeId(stored);
        return this.cachedNodeId;
      } catch {
        // Stored value is invalid — generate a new one
      }
    }

    // Generate new identity
    const newId = generateRandomNodeId();
    await this.storage.setItem(STORAGE_KEY, newId);
    this.cachedNodeId = newId;
    return newId;
  }

  /**
   * Synchronously get the cached node ID, or null if not yet loaded.
   * Useful for contexts where async is not available.
   */
  getCachedNodeId(): NodeId | null {
    return this.cachedNodeId;
  }

  /**
   * Force-set the node ID (for testing or manual override).
   */
  async setNodeId(nodeId: NodeId): Promise<void> {
    const normalized = normalizeNodeId(nodeId);
    await this.storage.setItem(STORAGE_KEY, normalized);
    this.cachedNodeId = normalized;
  }

  /**
   * Clear the cached node ID and remove from storage.
   */
  async clear(): Promise<void> {
    this.cachedNodeId = null;
    await this.storage.setItem(STORAGE_KEY, '');
  }
}
