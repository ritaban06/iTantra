/**
 * V9D Mesh Discovery Registry — Tests
 */

import { MeshDiscoveryRegistry } from '../mesh/MeshDiscoveryRegistry';

describe('MeshDiscoveryRegistry', () => {
  let clock: { time: number };
  let registry: MeshDiscoveryRegistry;

  beforeEach(() => {
    clock = { time: 1000 };
    registry = new MeshDiscoveryRegistry(128, 120_000, () => clock.time);
  });

  // ── Basic Record ──────────────────────────────────────────────

  it('records a discovered node', () => {
    registry.record('0x0000000000000001', 2);
    expect(registry.has('0x0000000000000001')).toBe(true);
    expect(registry.getCount()).toBe(1);
  });

  it('returns node info correctly', () => {
    registry.record('0x0000000000000001', 3, '0x00000000000000AA');
    const node = registry.get('0x0000000000000001');
    expect(node).toBeDefined();
    expect(node!.nodeId).toBe('0x0000000000000001');
    expect(node!.hopCount).toBe(3);
    expect(node!.reportedBy).toBe('0x00000000000000aa');
  });

  it('returns undefined for unknown node', () => {
    expect(registry.get('0x0000000000000099')).toBeUndefined();
    expect(registry.has('0x0000000000000099')).toBe(false);
  });

  // ── Rediscovery ───────────────────────────────────────────────

  it('rediscovery refreshes timestamp', () => {
    registry.record('0x0000000000000001', 2);
    const before = registry.get('0x0000000000000001')!.discoveredAt;

    clock.time += 5000;
    registry.record('0x0000000000000001', 3);
    const after = registry.get('0x0000000000000001')!.discoveredAt;

    expect(after).toBeGreaterThan(before);
  });

  it('rediscovery uses shorter hop count (advisory metadata)', () => {
    registry.record('0x0000000000000001', 5);
    registry.record('0x0000000000000001', 2);

    const node = registry.get('0x0000000000000001');
    // hopCount is advisory only — shorter value is preferred as metadata
    expect(node!.hopCount).toBe(2);
  });

  it('rediscovery keeps shorter hop count if new one is longer', () => {
    registry.record('0x0000000000000001', 2);
    registry.record('0x0000000000000001', 5);

    const node = registry.get('0x0000000000000001');
    expect(node!.hopCount).toBe(2);
  });

  it('hopCount is non-authoritative metadata only', () => {
    // hopCount is advisory metadata for discovery records.
    // It must NOT be used for routing, destination selection, or delivery.
    // This test documents that the registry stores it but does not
    // make routing decisions based on it.
    registry.record('0x0000000000000001', 10); // high hop count
    registry.record('0x0000000000000002', 0);  // direct peer

    // Both are discoverable regardless of hop count
    expect(registry.has('0x0000000000000001')).toBe(true);
    expect(registry.has('0x0000000000000002')).toBe(true);

    // hopCount is stored but is advisory only
    expect(registry.get('0x0000000000000001')!.hopCount).toBe(10);
    expect(registry.get('0x0000000000000002')!.hopCount).toBe(0);

    // The registry does NOT filter, sort, or make decisions based on hopCount
    const all = registry.getAll();
    expect(all.length).toBe(2);
  });

  it('does not create duplicate entries', () => {
    registry.record('0x0000000000000001', 1);
    registry.record('0x0000000000000001', 2);
    registry.record('0x0000000000000001', 3);

    expect(registry.getCount()).toBe(1);
  });

  // ── Multiple Nodes ────────────────────────────────────────────

  it('tracks multiple distinct nodes', () => {
    registry.record('0x0000000000000001', 1);
    registry.record('0x0000000000000002', 2);
    registry.record('0x0000000000000003', 3);

    expect(registry.getCount()).toBe(3);
    expect(registry.has('0x0000000000000001')).toBe(true);
    expect(registry.has('0x0000000000000002')).toBe(true);
    expect(registry.has('0x0000000000000003')).toBe(true);
  });

  it('getAll returns all non-expired nodes', () => {
    registry.record('0x0000000000000001', 1);
    registry.record('0x0000000000000002', 2);

    const all = registry.getAll();
    expect(all.length).toBe(2);
  });

  // ── Expiry ────────────────────────────────────────────────────

  it('expired entries are not returned', () => {
    registry.record('0x0000000000000001', 1);

    clock.time += 120_001; // past retention

    expect(registry.has('0x0000000000000001')).toBe(false);
    expect(registry.get('0x0000000000000001')).toBeUndefined();
  });

  it('pruneExpired removes expired entries', () => {
    registry.record('0x0000000000000001', 1);
    registry.record('0x0000000000000002', 2);

    clock.time += 120_001;

    const removed = registry.pruneExpired();
    expect(removed).toBe(2);
    expect(registry.getCount()).toBe(0);
  });

  it('pruneExpired only removes expired entries', () => {
    registry.record('0x0000000000000001', 1); // recorded at t=1000

    clock.time += 60_000; // t=61000
    registry.record('0x0000000000000002', 2); // recorded at t=61000

    clock.time += 70_000; // t=131000

    const removed = registry.pruneExpired();
    expect(removed).toBe(1); // only node 01 expired (131000 - 1000 > 120000)
    expect(registry.has('0x0000000000000001')).toBe(false);
    expect(registry.has('0x0000000000000002')).toBe(true);
  });

  // ── Max Size ──────────────────────────────────────────────────

  it('evicts oldest entry when max size exceeded', () => {
    const smallRegistry = new MeshDiscoveryRegistry(3, 120_000, () => clock.time);

    smallRegistry.record('0x0000000000000001', 1);
    clock.time += 1;
    smallRegistry.record('0x0000000000000002', 2);
    clock.time += 1;
    smallRegistry.record('0x0000000000000003', 3);
    clock.time += 1;
    smallRegistry.record('0x0000000000000004', 4); // evicts oldest (01)

    expect(smallRegistry.getCount()).toBe(3);
    expect(smallRegistry.has('0x0000000000000001')).toBe(false);
    expect(smallRegistry.has('0x0000000000000002')).toBe(true);
    expect(smallRegistry.has('0x0000000000000004')).toBe(true);
  });

  // ── Clear ─────────────────────────────────────────────────────

  it('clear removes all entries', () => {
    registry.record('0x0000000000000001', 1);
    registry.record('0x0000000000000002', 2);

    registry.clear();
    expect(registry.getCount()).toBe(0);
  });

  // ── NodeId Normalization ──────────────────────────────────────

  it('normalizes NodeId before storing', () => {
    registry.record('0xABCD' as any, 1); // not standard format but normalizeNodeId handles it
    expect(registry.has('0x000000000000abcd')).toBe(true);
  });
});
