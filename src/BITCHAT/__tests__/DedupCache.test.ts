/**
 * V9A BitChat DedupCache — Tests
 */

import { DedupCache } from '../mesh/DedupCache';
import { DEDUP_MAX_ENTRIES, DEDUP_RETENTION_MS } from '../core/BitChatConstants';

describe('DedupCache', () => {
  let clock: { time: number; now: () => number };
  let cache: DedupCache;

  beforeEach(() => {
    clock = { time: 1000, now: () => clock.time };
    cache = new DedupCache(DEDUP_MAX_ENTRIES, DEDUP_RETENTION_MS, clock.now);
  });

  afterEach(() => {
    cache.clear();
  });

  it('first packet returns false (not duplicate)', () => {
    expect(cache.checkAndMark('0x0000000000000001', '0x0000000000000001')).toBe(false);
  });

  it('duplicate packet returns true', () => {
    cache.checkAndMark('0x0000000000000001', '0x0000000000000001');
    expect(cache.checkAndMark('0x0000000000000001', '0x0000000000000001')).toBe(true);
  });

  it('different source same packetId is NOT a duplicate', () => {
    cache.checkAndMark('0x0000000000000001', '0x0000000000000001');
    expect(cache.checkAndMark('0x0000000000000002', '0x0000000000000001')).toBe(false);
  });

  it('same source different packetId is NOT a duplicate', () => {
    cache.checkAndMark('0x0000000000000001', '0x0000000000000001');
    expect(cache.checkAndMark('0x0000000000000001', '0x0000000000000002')).toBe(false);
  });

  it('has() returns true for seen packet without marking', () => {
    cache.markSeen('0x0000000000000001', '0x0000000000000001');
    expect(cache.has('0x0000000000000001', '0x0000000000000001')).toBe(true);
    expect(cache.has('0x0000000000000001', '0x0000000000000002')).toBe(false);
  });

  it('markSeen increases count', () => {
    cache.markSeen('0x0000000000000001', '0x0000000000000001');
    expect(cache.getCount()).toBe(1);
  });

  it('checkAndMark increases count for first packet', () => {
    cache.checkAndMark('0x0000000000000001', '0x0000000000000001');
    expect(cache.getCount()).toBe(1);
  });

  it('checkAndMark does NOT increase count for duplicate', () => {
    cache.checkAndMark('0x0000000000000001', '0x0000000000000001');
    cache.checkAndMark('0x0000000000000001', '0x0000000000000001');
    expect(cache.getCount()).toBe(1);
  });

  it('expiry: entries older than retention are pruned', () => {
    cache.markSeen('0x0000000000000001', '0x0000000000000001');
    clock.time += DEDUP_RETENTION_MS + 1000;
    const removed = cache.pruneExpired();
    expect(removed).toBe(1);
    expect(cache.has('0x0000000000000001', '0x0000000000000001')).toBe(false);
  });

  it('expiry: recent entries are NOT pruned', () => {
    cache.markSeen('0x0000000000000001', '0x0000000000000001');
    clock.time += DEDUP_RETENTION_MS - 1000;
    const removed = cache.pruneExpired();
    expect(removed).toBe(0);
    expect(cache.has('0x0000000000000001', '0x0000000000000001')).toBe(true);
  });

  it('max size: oldest entry is evicted when capacity exceeded', () => {
    const smallCache = new DedupCache(3, DEDUP_RETENTION_MS, clock.now);

    smallCache.markSeen('0x0000000000000001', '0x0000000000000001');
    smallCache.markSeen('0x0000000000000002', '0x0000000000000002');
    smallCache.markSeen('0x0000000000000003', '0x0000000000000003');
    // Cache full (3 entries)

    smallCache.markSeen('0x0000000000000004', '0x0000000000000004');
    // Oldest (0x01) should be evicted

    expect(smallCache.getCount()).toBe(3);
    expect(smallCache.has('0x0000000000000001', '0x0000000000000001')).toBe(false);
    expect(smallCache.has('0x0000000000000004', '0x0000000000000004')).toBe(true);
  });

  it('checkAndMark same packet replaces entry (updates timestamp)', () => {
    cache.checkAndMark('0x0000000000000001', '0x0000000000000001');
    clock.time += 1000;
    cache.checkAndMark('0x0000000000000001', '0x0000000000000001'); // duplicate
    expect(cache.getCount()).toBe(1);
  });

  it('normalization: unnormalized keys work correctly', () => {
    cache.markSeen('0xFF', '0xAB');
    expect(cache.has('0x00000000000000ff', '0x00000000000000ab')).toBe(true);
    expect(cache.checkAndMark('0xFF', '0xAB')).toBe(true);
  });

  it('clear empties the cache', () => {
    cache.markSeen('0x0000000000000001', '0x0000000000000001');
    cache.clear();
    expect(cache.getCount()).toBe(0);
    expect(cache.has('0x0000000000000001', '0x0000000000000001')).toBe(false);
  });
});
