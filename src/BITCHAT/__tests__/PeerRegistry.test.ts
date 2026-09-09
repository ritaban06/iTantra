/**
 * V9A BitChat PeerRegistry — Tests
 */

import { PeerRegistry } from '../peer/PeerRegistry';
import { normalizeNodeId } from '../core/BitChatPacket';
import { PEER_STALE_THRESHOLD_MS } from '../core/BitChatConstants';

describe('PeerRegistry', () => {
  let clock: { time: number; now: () => number };
  let registry: PeerRegistry;

  beforeEach(() => {
    clock = { time: 1000, now: () => clock.time };
    registry = new PeerRegistry(PEER_STALE_THRESHOLD_MS, clock.now);
  });

  afterEach(() => {
    registry.clear();
  });

  it('add peer', () => {
    const info = registry.upsertPeer('0x0000000000000001');
    expect(info.peerId).toBe('0x0000000000000001');
    expect(info.state).toBe('DISCOVERED');
    expect(info.lastSeen).toBe(1000);
  });

  it('add peer with RSSI', () => {
    const info = registry.upsertPeer('0x0000000000000001', -50);
    expect(info.rssi).toBe(-50);
  });

  it('update peer updates lastSeen', () => {
    registry.upsertPeer('0x0000000000000001');
    clock.time = 2000;
    const info = registry.upsertPeer('0x0000000000000001', -60);
    expect(info.lastSeen).toBe(2000);
    expect(info.rssi).toBe(-60);
  });

  it('getPeer returns existing peer', () => {
    registry.upsertPeer('0x0000000000000001');
    expect(registry.getPeer('0x0000000000000001')).toBeDefined();
  });

  it('getPeer returns undefined for unknown peer', () => {
    expect(registry.getPeer('0x0000000000000099')).toBeUndefined();
  });

  it('getPeers returns all peers', () => {
    registry.upsertPeer('0x0000000000000001');
    registry.upsertPeer('0x0000000000000002');
    expect(registry.getPeers().length).toBe(2);
  });

  it('markSeen creates peer if not exists', () => {
    registry.markSeen('0x0000000000000001');
    expect(registry.getPeer('0x0000000000000001')).toBeDefined();
  });

  it('markSeen updates lastSeen', () => {
    registry.markSeen('0x0000000000000001');
    clock.time = 5000;
    registry.markSeen('0x0000000000000001');
    expect(registry.getPeer('0x0000000000000001')!.lastSeen).toBe(5000);
  });

  it('markConnected sets state to CONNECTED', () => {
    registry.markConnected('0x0000000000000001');
    expect(registry.getPeer('0x0000000000000001')!.state).toBe('CONNECTED');
  });

  it('markDisconnected sets state to DISCOVERED', () => {
    registry.markConnected('0x0000000000000001');
    registry.markDisconnected('0x0000000000000001');
    expect(registry.getPeer('0x0000000000000001')!.state).toBe('DISCOVERED');
  });

  it('stale pruning marks old peers as STALE', () => {
    registry.upsertPeer('0x0000000000000001');
    clock.time += PEER_STALE_THRESHOLD_MS + 1000;
    const count = registry.pruneStale();
    expect(count).toBe(1);
    expect(registry.getPeer('0x0000000000000001')!.state).toBe('STALE');
  });

  it('stale pruning does not mark recent peers', () => {
    registry.upsertPeer('0x0000000000000001');
    clock.time += PEER_STALE_THRESHOLD_MS - 1000;
    const count = registry.pruneStale();
    expect(count).toBe(0);
    expect(registry.getPeer('0x0000000000000001')!.state).toBe('DISCOVERED');
  });

  it('removePeer removes peer', () => {
    registry.upsertPeer('0x0000000000000001');
    expect(registry.removePeer('0x0000000000000001')).toBe(true);
    expect(registry.getPeer('0x0000000000000001')).toBeUndefined();
  });

  it('removePeer returns false for unknown peer', () => {
    expect(registry.removePeer('0x0000000000000099')).toBe(false);
  });

  it('clear removes all peers', () => {
    registry.upsertPeer('0x0000000000000001');
    registry.upsertPeer('0x0000000000000002');
    registry.clear();
    expect(registry.getPeers().length).toBe(0);
  });

  it('duplicate upsert preserves state', () => {
    registry.markConnected('0x0000000000000001');
    registry.upsertPeer('0x0000000000000001');
    expect(registry.getPeer('0x0000000000000001')!.state).toBe('CONNECTED');
  });

  it('peerId is normalized', () => {
    registry.upsertPeer('0xFF');
    const peer = registry.getPeer('0xFF');
    expect(peer!.peerId).toBe(normalizeNodeId('0xFF'));
  });
});
