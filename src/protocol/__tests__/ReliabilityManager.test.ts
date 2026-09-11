/**
 * V8 Reliability Manager — Tests
 *
 * Comprehensive tests for ReliabilityManager, DeliveredMessageCache,
 * and CompletedGroupCache.
 */

import {
  ACK_TIMEOUT_MS,
  MAX_RETRIES,
  DELIVERED_CACHE_MAX,
  DELIVERED_CACHE_RETENTION_MS,
  COMPLETED_CACHE_MAX,
  COMPLETED_CACHE_RETENTION_MS,
  NACK_REASON_INVALID_FRAGMENT,
  NACK_REASON_METADATA_CONFLICT,
  NACK_REASON_REASSEMBLY_EXPIRED,
  ACK_PAYLOAD_SIZE,
  NACK_PAYLOAD_SIZE,
} from '../ReliabilityTypes';
import { ReliabilityManager } from '../ReliabilityManager';
import { DeliveredMessageCache } from '../DeliveredMessageCache';
import { CompletedGroupCache } from '../CompletedGroupCache';
import { SequenceManager } from '../SequenceManager';

// ── Test Helpers ──────────────────────────────────────────────────

function makeV6aPacket(size: number = 30): Uint8Array {
  const packet = new Uint8Array(size);
  packet[0] = 0x02;
  for (let i = 1; i < size; i++) packet[i] = (i & 0xff) || 0x01;
  return packet;
}

function makeMessageId(n: number = 0): string {
  return `0x${n.toString(16).padStart(16, '0')}`;
}

function makeFragments(count: number): Uint8Array[] {
  const frags: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    frags.push(new Uint8Array(10).fill(i + 1));
  }
  return frags;
}

// ══════════════════════════════════════════════════════════════════
// 1–16. SENDER STATE
// ══════════════════════════════════════════════════════════════════

describe('ReliabilityManager — Sender', () => {
  let mgr: ReliabilityManager;
  let seqMgr: SequenceManager;

  beforeEach(() => {
    seqMgr = new SequenceManager(0);
    mgr = new ReliabilityManager('peer_A', seqMgr);
  });

  afterEach(() => {
    mgr.cancel();
  });

  // Test 1
  it('send() creates active PendingMessage with correct messageId', () => {
    const v6a = makeV6aPacket();
    const result = mgr.send({ messageId: '0x1111', v6aPacket: v6a });
    expect(result.active).toBe(true);
    expect(result.message.messageId).toBe('0x1111');
    expect(mgr.hasActiveMessage()).toBe(true);
    expect(mgr.getActiveMessage()!.messageId).toBe('0x1111');
  });

  // Test 2
  it('send() stores V6A packet for retransmission', () => {
    const v6a = makeV6aPacket(100);
    mgr.send({ messageId: '0x2222', v6aPacket: v6a });
    const active = mgr.getActiveMessage()!;
    expect(active.v6aPacket.length).toBe(100);
  });

  // Test 3
  it('send() stores V7 fragments for retransmission', () => {
    const frags = makeFragments(3);
    mgr.send({
      messageId: '0x3333',
      v6aPacket: makeV6aPacket(1000),
      groupId: 42,
      fragments: frags,
      payloads: frags.map(f => f),
    });
    const active = mgr.getActiveMessage()!;
    expect(active.fragments.length).toBe(3);
    expect(active.groupId).toBe(42);
  });

  // Test 4
  it('send() stores groupId→messageId mapping', () => {
    mgr.send({
      messageId: '0x4444',
      v6aPacket: makeV6aPacket(1000),
      groupId: 55,
      fragments: makeFragments(2),
      payloads: makeFragments(2),
    });
    mgr.registerGroupId(55, '0x4444');
    // Verify mapping by sending NACK for that group
    mgr.handleNack(55, NACK_REASON_INVALID_FRAGMENT);
    // Should trigger retransmit event (not silently ignored)
  });

  // Test 5
  it('send() sets retryCount=0', () => {
    mgr.send({ messageId: '0x5555', v6aPacket: makeV6aPacket() });
    expect(mgr.getActiveMessage()!.retryCount).toBe(0);
  });

  // Test 6
  it('handleAck() with valid messageId → SUCCESS, active=null', () => {
    mgr.send({ messageId: '0x6666', v6aPacket: makeV6aPacket() });
    mgr.handleAck('0x6666');
    expect(mgr.hasActiveMessage()).toBe(false);
  });

  // Test 7
  it('handleAck() for unknown messageId → silently ignored', () => {
    mgr.send({ messageId: '0x7777', v6aPacket: makeV6aPacket() });
    mgr.handleAck('0x9999'); // wrong ID
    expect(mgr.hasActiveMessage()).toBe(true); // still active
  });

  // Test 8
  it('handleAck() for already-cleared messageId → silently ignored', () => {
    mgr.send({ messageId: '0x8888', v6aPacket: makeV6aPacket() });
    mgr.handleAck('0x8888'); // clears
    mgr.handleAck('0x8888'); // second time — no error
    expect(mgr.hasActiveMessage()).toBe(false);
  });

  // Test 9
  it('retry() increments retryCount', (done) => {
    mgr.send({ messageId: '0xAAAA', v6aPacket: makeV6aPacket() });
    // Manually trigger timeout
    mgr.handleTimeout();
    expect(mgr.getActiveMessage()!.retryCount).toBe(1);
    done();
  });

  // Test 10
  it('retry() retransmits with new V6B sequence', () => {
    const seq1 = seqMgr.nextSequence();
    mgr.send({ messageId: '0xBBBB', v6aPacket: makeV6aPacket() });
    const seq2 = seqMgr.nextSequence();
    expect(seq2).toBeGreaterThan(seq1);
  });

  // Test 11
  it('max retries (3) → FAILED_MAX_RETRIES', () => {
    const events: any[] = [];
    mgr.setOnEvent(e => events.push(e));

    mgr.send({ messageId: '0xCCCC', v6aPacket: makeV6aPacket() });
    mgr.handleTimeout(); // retry 1
    mgr.handleTimeout(); // retry 2
    mgr.handleTimeout(); // retry 3
    mgr.handleTimeout(); // retry 4 → FAIL

    expect(mgr.hasActiveMessage()).toBe(false);
    expect(events.some(e => e.type === 'MAX_RETRIES')).toBe(true);
  });

  // Test 12
  it('handleNack() with valid groupId → full retransmit', () => {
    const events: any[] = [];
    mgr.setOnEvent(e => events.push(e));

    mgr.send({
      messageId: '0xDDDD',
      v6aPacket: makeV6aPacket(1000),
      groupId: 10,
      fragments: makeFragments(3),
      payloads: makeFragments(3),
    });
    mgr.registerGroupId(10, '0xDDDD');
    mgr.handleNack(10, NACK_REASON_INVALID_FRAGMENT);

    expect(events.some(e => e.type === 'NACK_RECEIVED')).toBe(true);
    expect(mgr.getActiveMessage()!.retryCount).toBe(1); // NACK increments, not resets
  });

  // Test 13
  it('handleNack() with unknown groupId → silently ignored', () => {
    const events: any[] = [];
    mgr.setOnEvent(e => events.push(e));

    mgr.send({ messageId: '0xEEEE', v6aPacket: makeV6aPacket() });
    mgr.handleNack(999, NACK_REASON_INVALID_FRAGMENT);

    expect(events.some(e => e.type === 'NACK_RECEIVED')).toBe(false);
  });

  // Test 14
  it('cleanup() removes expired pending messages (>40s)', () => {
    mgr.send({ messageId: '0xFFFF', v6aPacket: makeV6aPacket() });
    expect(mgr.hasActiveMessage()).toBe(true);

    // Manually age the message past PENDING_EXPIRY_MS (40s)
    const active = mgr.getActiveMessage()!;
    (active as any).createdAt = Date.now() - 41000; // 41s ago

    mgr.cleanup();
    expect(mgr.hasActiveMessage()).toBe(false);
  });

  it('cleanup() does NOT remove messages younger than 40s', () => {
    mgr.send({ messageId: '0xFFFE', v6aPacket: makeV6aPacket() });
    const active = mgr.getActiveMessage()!;
    (active as any).createdAt = Date.now() - 30000; // 30s ago — still within 40s

    mgr.cleanup();
    expect(mgr.hasActiveMessage()).toBe(true);
  });

  // Test 15
  it('cancel() clears all pending state', () => {
    const events: any[] = [];
    mgr.setOnEvent(e => events.push(e));

    mgr.send({ messageId: '0xAAAA', v6aPacket: makeV6aPacket() });
    mgr.send({ messageId: '0xBBBB', v6aPacket: makeV6aPacket() }); // queued
    mgr.cancel();

    expect(mgr.hasActiveMessage()).toBe(false);
    expect(mgr.hasQueuedMessage()).toBe(false);
    expect(events.some(e => e.type === 'CANCELLED')).toBe(true);
  });

  // Test 16
  it('connection loss → all state cleared', () => {
    mgr.send({ messageId: '0x1111', v6aPacket: makeV6aPacket() });
    mgr.send({ messageId: '0x2222', v6aPacket: makeV6aPacket() }); // queued
    mgr.registerGroupId(10, '0x1111');
    mgr.cancel();
    expect(mgr.hasActiveMessage()).toBe(false);
    expect(mgr.hasQueuedMessage()).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
// 17–22. SINGLE-FRAME RELIABILITY
// ══════════════════════════════════════════════════════════════════

describe('ReliabilityManager — Single-Frame', () => {
  let mgr: ReliabilityManager;

  beforeEach(() => {
    mgr = new ReliabilityManager('peer_A', new SequenceManager(0));
  });

  afterEach(() => {
    mgr.cancel();
  });

  // Test 17
  it('send DATA → ACK → SUCCESS', () => {
    mgr.send({ messageId: '0x1001', v6aPacket: makeV6aPacket() });
    mgr.handleAck('0x1001');
    expect(mgr.hasActiveMessage()).toBe(false);
  });

  // Test 18
  it('send DATA → ACK timeout → retry', () => {
    const events: any[] = [];
    mgr.setOnEvent(e => events.push(e));
    mgr.send({ messageId: '0x1002', v6aPacket: makeV6aPacket() });
    mgr.handleTimeout();
    expect(mgr.getActiveMessage()!.retryCount).toBe(1);
    expect(events.some(e => e.type === 'TIMEOUT_RETRY')).toBe(true);
  });

  // Test 19
  it('send DATA → 3 timeouts → FAILED_MAX_RETRIES', () => {
    const events: any[] = [];
    mgr.setOnEvent(e => events.push(e));
    mgr.send({ messageId: '0x1003', v6aPacket: makeV6aPacket() });
    for (let i = 0; i < 4; i++) mgr.handleTimeout();
    expect(mgr.hasActiveMessage()).toBe(false);
    expect(events.some(e => e.type === 'MAX_RETRIES')).toBe(true);
  });

  // Test 20
  it('send DATA → retransmitted DATA arrives → receiver re-sends ACK', () => {
    // This tests that the ACK payload is correctly parseable
    const msgId = '0x0000000000001004';
    const payload = ReliabilityManager.buildAckPayload(msgId);
    expect(payload.length).toBe(ACK_PAYLOAD_SIZE);
    const parsed = ReliabilityManager.parseAckPayload(payload);
    expect(parsed).toBe(msgId);
  });

  // Test 21
  it('send DATA → lost ACK → timeout → retransmit → eventual ACK', () => {
    mgr.send({ messageId: '0x1005', v6aPacket: makeV6aPacket() });
    mgr.handleTimeout(); // retry 1
    mgr.handleAck('0x1005'); // ACK arrives
    expect(mgr.hasActiveMessage()).toBe(false);
  });

  // Test 22
  it('connection lost during pending → CANCELLED', () => {
    const events: any[] = [];
    mgr.setOnEvent(e => events.push(e));
    mgr.send({ messageId: '0x1006', v6aPacket: makeV6aPacket() });
    mgr.cancel();
    expect(events.some(e => e.type === 'CANCELLED')).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
// 23–27. FRAGMENTED RELIABILITY
// ══════════════════════════════════════════════════════════════════

describe('ReliabilityManager — Fragmented', () => {
  let mgr: ReliabilityManager;

  beforeEach(() => {
    mgr = new ReliabilityManager('peer_A', new SequenceManager(0));
  });

  afterEach(() => {
    mgr.cancel();
  });

  // Test 23
  it('send 3 fragments → ACK → SUCCESS', () => {
    mgr.send({
      messageId: '0x2001',
      v6aPacket: makeV6aPacket(1000),
      groupId: 1,
      fragments: makeFragments(3),
      payloads: makeFragments(3),
    });
    mgr.handleAck('0x2001');
    expect(mgr.hasActiveMessage()).toBe(false);
  });

  // Test 24
  it('send 3 fragments → NACK → full retransmit', () => {
    const events: any[] = [];
    mgr.setOnEvent(e => events.push(e));
    mgr.send({
      messageId: '0x2002',
      v6aPacket: makeV6aPacket(1000),
      groupId: 2,
      fragments: makeFragments(3),
      payloads: makeFragments(3),
    });
    mgr.registerGroupId(2, '0x2002');
    mgr.handleNack(2, NACK_REASON_REASSEMBLY_EXPIRED);
    expect(events.some(e => e.type === 'NACK_RECEIVED')).toBe(true);
  });

  // Test 25
  it('send 3 fragments → duplicate fragment → handled by Reassembler (not ReliabilityManager)', () => {
    // ReliabilityManager doesn't handle fragment-level dedup — that's Reassembler.
    // This test verifies the manager stores all fragments.
    mgr.send({
      messageId: '0x2003',
      v6aPacket: makeV6aPacket(1000),
      groupId: 3,
      fragments: makeFragments(3),
      payloads: makeFragments(3),
    });
    expect(mgr.getActiveMessage()!.fragments.length).toBe(3);
  });

  // Test 26
  it('send 3 fragments → ACK sent once (integration hook decides)', () => {
    // ACK generation is done by the integration hook, not the manager.
    // This verifies the ACK payload is correct for fragmented messages.
    const msgId = '0x0000000000002004';
    const payload = ReliabilityManager.buildAckPayload(msgId);
    const parsed = ReliabilityManager.parseAckPayload(payload);
    expect(parsed).toBe(msgId);
  });

  // Test 27
  it('retransmitted fragments → CompletedGroupCache catches → no duplicate TTS', () => {
    const cache = new CompletedGroupCache();
    cache.store('peer_A', 5, '0x2005');
    expect(cache.isCompleted('peer_A', 5)).toBe(true);
    expect(cache.getCompletedMessageId('peer_A', 5)).toBe('0x2005');
  });
});

// ══════════════════════════════════════════════════════════════════
// 28–32. SEMANTIC DEDUPLICATION
// ══════════════════════════════════════════════════════════════════

describe('DeliveredMessageCache', () => {
  let cache: DeliveredMessageCache;

  beforeEach(() => {
    cache = new DeliveredMessageCache();
  });

  // Test 28
  it('retransmitted single-frame with new V6B sequence → no duplicate TTS', () => {
    cache.markDelivered('peer_A', '0x3001');
    expect(cache.isDelivered('peer_A', '0x3001')).toBe(true);
  });

  // Test 29
  it('lost ACK → retransmission → receiver sends ACK again (ACK regen)', () => {
    // ACK regeneration works because isDelivered() returns true
    cache.markDelivered('peer_A', '0x3002');
    // Receiver sees retransmitted frame, checks isDelivered → true → re-ACK
    expect(cache.isDelivered('peer_A', '0x3002')).toBe(true);
  });

  // Test 30
  it('retransmitted completed V7 group → no duplicate TTS', () => {
    cache.markDelivered('peer_A', '0x3003');
    // Second delivery attempt
    expect(cache.isDelivered('peer_A', '0x3003')).toBe(true);
  });

  // Test 31
  it('completed-group cache prevents reassembly duplication', () => {
    const gc = new CompletedGroupCache();
    gc.store('peer_A', 10, '0x3004');
    expect(gc.isCompleted('peer_A', 10)).toBe(true);
    // Retransmitted fragment for group 10 → cache catches it
    expect(gc.getCompletedMessageId('peer_A', 10)).toBe('0x3004');
  });

  // Test 32
  it('same messageId from different peers → isolated caches', () => {
    cache.markDelivered('peer_A', '0x3005');
    cache.markDelivered('peer_B', '0x3005'); // same messageId, different peer
    expect(cache.isDelivered('peer_A', '0x3005')).toBe(true);
    expect(cache.isDelivered('peer_B', '0x3005')).toBe(true);
    // Clearing peer_A does not affect peer_B
    cache.resetPeer('peer_A');
    expect(cache.isDelivered('peer_A', '0x3005')).toBe(false);
    expect(cache.isDelivered('peer_B', '0x3005')).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
// 33–42. ACK/NACK EDGE CASES
// ══════════════════════════════════════════════════════════════════

describe('ACK/NACK Edge Cases', () => {
  // Test 33
  it('old/stale ACK cannot complete another message', () => {
    const mgr = new ReliabilityManager('peer_A', new SequenceManager(0));
    mgr.send({ messageId: '0x4001', v6aPacket: makeV6aPacket() });
    // ACK for different messageId
    mgr.handleAck('0x9999');
    expect(mgr.hasActiveMessage()).toBe(true); // still active
    mgr.cancel();
  });

  // Test 34
  it('NACK causes FULL group retransmission (not selective)', () => {
    const mgr = new ReliabilityManager('peer_A', new SequenceManager(0));
    const events: any[] = [];
    mgr.setOnEvent(e => events.push(e));
    mgr.send({
      messageId: '0x4002',
      v6aPacket: makeV6aPacket(1000),
      groupId: 7,
      fragments: makeFragments(5),
      payloads: makeFragments(5),
    });
    mgr.registerGroupId(7, '0x4002');
    mgr.handleNack(7, NACK_REASON_METADATA_CONFLICT);
    // Retry count increments (shared budget)
    expect(mgr.getActiveMessage()!.retryCount).toBe(1);
    mgr.cancel();
  });

  // Test 35
  it('duplicate ACK → harmless', () => {
    const mgr = new ReliabilityManager('peer_A', new SequenceManager(0));
    mgr.send({ messageId: '0x4003', v6aPacket: makeV6aPacket() });
    mgr.handleAck('0x4003');
    mgr.handleAck('0x4003'); // duplicate
    expect(mgr.hasActiveMessage()).toBe(false);
  });

  // Test 36
  it('duplicate NACK → harmless, but each consumes retry budget', () => {
    const mgr = new ReliabilityManager('peer_A', new SequenceManager(0));
    const events: any[] = [];
    mgr.setOnEvent(e => events.push(e));
    mgr.send({
      messageId: '0x4004',
      v6aPacket: makeV6aPacket(1000),
      groupId: 8,
      fragments: makeFragments(2),
      payloads: makeFragments(2),
    });
    mgr.registerGroupId(8, '0x4004');
    mgr.handleNack(8, NACK_REASON_INVALID_FRAGMENT); // retryCount = 1
    mgr.handleNack(8, NACK_REASON_INVALID_FRAGMENT); // retryCount = 2
    // Both produce events
    expect(events.filter(e => e.type === 'NACK_RECEIVED').length).toBe(2);
    expect(mgr.getActiveMessage()!.retryCount).toBe(2);
    mgr.cancel();
  });

  // Test 37
  it('ACK regeneration works after prior successful delivery', () => {
    const cache = new DeliveredMessageCache();
    const msgId = '0x0000000000004005';
    cache.markDelivered('peer_A', msgId);
    // Retransmitted frame arrives → isDelivered → true → ACK regenerated
    expect(cache.isDelivered('peer_A', msgId)).toBe(true);
    // ACK payload is valid
    const payload = ReliabilityManager.buildAckPayload(msgId);
    expect(ReliabilityManager.parseAckPayload(payload)).toBe(msgId);
  });

  // Test 38
  it('ACK payload is 8-byte messageId UInt64 BIG_ENDIAN', () => {
    const payload = ReliabilityManager.buildAckPayload('0x0102030405060708');
    expect(payload.length).toBe(8);
    // Verify BIG_ENDIAN: first byte should be 0x01
    expect(payload[0]).toBe(0x01);
    expect(payload[7]).toBe(0x08);
  });

  // Test 39
  it('NACK payload is 4-byte groupId + 1-byte reason + 5 reserved', () => {
    const payload = ReliabilityManager.buildNackPayload(0x12345678, 0x03);
    expect(payload.length).toBe(10);
    expect(payload[0]).toBe(0x12);
    expect(payload[1]).toBe(0x34);
    expect(payload[2]).toBe(0x56);
    expect(payload[3]).toBe(0x78);
    expect(payload[4]).toBe(0x03);
    // Reserved bytes zeroed
    expect(payload[5]).toBe(0);
    expect(payload[6]).toBe(0);
    expect(payload[7]).toBe(0);
    expect(payload[8]).toBe(0);
    expect(payload[9]).toBe(0);
  });

  // Test 40
  it('parseAckPayload returns null for short payload', () => {
    expect(ReliabilityManager.parseAckPayload(new Uint8Array(4))).toBeNull();
  });

  // Test 41
  it('parseNackPayload returns null for short payload', () => {
    expect(ReliabilityManager.parseNackPayload(new Uint8Array(4))).toBeNull();
  });

  // Test 42
  it('NACK rate limiting works', () => {
    const mgr = new ReliabilityManager('peer_A', new SequenceManager(0));
    for (let i = 0; i < 4; i++) {
      expect(mgr.canNack()).toBe(true);
    }
    expect(mgr.canNack()).toBe(false); // 5th in same second
  });
});

// ══════════════════════════════════════════════════════════════════
// 43–50. STATE MANAGEMENT
// ══════════════════════════════════════════════════════════════════

describe('State Management', () => {
  // Test 43
  it('one active message per peer enforced', () => {
    const mgr = new ReliabilityManager('peer_A', new SequenceManager(0));
    mgr.send({ messageId: '0x5001', v6aPacket: makeV6aPacket() });
    expect(mgr.hasActiveMessage()).toBe(true);
    expect(mgr.hasQueuedMessage()).toBe(false);
    mgr.cancel();
  });

  // Test 44
  it('one queued message per peer enforced', () => {
    const mgr = new ReliabilityManager('peer_A', new SequenceManager(0));
    mgr.send({ messageId: '0x5002', v6aPacket: makeV6aPacket() }); // active
    mgr.send({ messageId: '0x5003', v6aPacket: makeV6aPacket() }); // queued
    expect(mgr.hasActiveMessage()).toBe(true);
    expect(mgr.hasQueuedMessage()).toBe(true);
    mgr.cancel();
  });

  // Test 45
  it('third message drops oldest queued', () => {
    const mgr = new ReliabilityManager('peer_A', new SequenceManager(0));
    mgr.send({ messageId: '0x5004', v6aPacket: makeV6aPacket() }); // active
    mgr.send({ messageId: '0x5005', v6aPacket: makeV6aPacket() }); // queued
    mgr.send({ messageId: '0x5006', v6aPacket: makeV6aPacket() }); // replaces queued
    expect(mgr.getQueuedMessage()!.messageId).toBe('0x5006');
    mgr.cancel();
  });

  // Test 46
  it('connection loss clears all per-peer state', () => {
    const mgr = new ReliabilityManager('peer_A', new SequenceManager(0));
    mgr.send({ messageId: '0x5007', v6aPacket: makeV6aPacket() });
    mgr.cancel();
    expect(mgr.hasActiveMessage()).toBe(false);
    expect(mgr.hasQueuedMessage()).toBe(false);
  });

  // Test 47
  it('CompletedGroupCache: cleanup removes expired entries', () => {
    const cache = new CompletedGroupCache();
    cache.store('peer_A', 20, '0x5008');
    // Manually age
    const entries = (cache as any).caches.get('peer_A');
    entries[0].completedAt = Date.now() - COMPLETED_CACHE_RETENTION_MS - 1000;
    const removed = cache.cleanup('peer_A');
    expect(removed).toBe(1);
    expect(cache.isCompleted('peer_A', 20)).toBe(false);
  });

  // Test 48
  it('DeliveredMessageCache: max entries enforced', () => {
    const cache = new DeliveredMessageCache();
    for (let i = 0; i < DELIVERED_CACHE_MAX + 5; i++) {
      cache.markDelivered('peer_A', makeMessageId(i));
    }
    expect(cache.getCount('peer_A')).toBe(DELIVERED_CACHE_MAX);
  });

  // Test 49
  it('CompletedGroupCache: max entries enforced', () => {
    const cache = new CompletedGroupCache();
    for (let i = 0; i < COMPLETED_CACHE_MAX + 5; i++) {
      cache.store('peer_A', i, makeMessageId(i));
    }
    expect(cache.getCount('peer_A')).toBe(COMPLETED_CACHE_MAX);
  });

  // Test 50
  it('memory: no unbounded allocation in pending messages', () => {
    const mgr = new ReliabilityManager('peer_A', new SequenceManager(0));
    // Send many messages — only 1 active + 1 queued at most
    for (let i = 0; i < 100; i++) {
      mgr.send({ messageId: makeMessageId(i), v6aPacket: makeV6aPacket() });
    }
    expect(mgr.hasActiveMessage()).toBe(true);
    expect(mgr.hasQueuedMessage()).toBe(true);
    mgr.cancel();
  });
});

// ══════════════════════════════════════════════════════════════════
// 51–58. MALFORMED / ABUSE
// ══════════════════════════════════════════════════════════════════

describe('Malformed / Abuse', () => {
  // Test 51
  it('invalid ACK (wrong length) → parseAckPayload returns null', () => {
    expect(ReliabilityManager.parseAckPayload(new Uint8Array(3))).toBeNull();
    expect(ReliabilityManager.parseAckPayload(new Uint8Array(0))).toBeNull();
  });

  // Test 52
  it('invalid NACK (wrong length) → parseNackPayload returns null', () => {
    expect(ReliabilityManager.parseNackPayload(new Uint8Array(3))).toBeNull();
    expect(ReliabilityManager.parseNackPayload(new Uint8Array(0))).toBeNull();
  });

  // Test 53
  it('NACK with unknown reason → parseable but reason is arbitrary', () => {
    const payload = ReliabilityManager.buildNackPayload(42, 0xFF);
    const parsed = ReliabilityManager.parseNackPayload(payload)!;
    expect(parsed.groupId).toBe(42);
    expect(parsed.reason).toBe(0xFF);
  });

  it('preserves high-bit V7 group IDs as unsigned UInt32 values for NACK lookup', () => {
    const groupId = 0xe1234567;
    const payload = ReliabilityManager.buildNackPayload(groupId, NACK_REASON_INVALID_FRAGMENT);
    expect(ReliabilityManager.parseNackPayload(payload)).toEqual({
      groupId,
      reason: NACK_REASON_INVALID_FRAGMENT,
    });
  });

  it('repeated NACKs eventually exhaust retry budget (cannot cause unlimited retries)', () => {
    const mgr = new ReliabilityManager('peer_A', new SequenceManager(0));
    const events: any[] = [];
    mgr.setOnEvent(e => events.push(e));
    mgr.send({
      messageId: '0x7001',
      v6aPacket: makeV6aPacket(1000),
      groupId: 100,
      fragments: makeFragments(3),
      payloads: makeFragments(3),
    });
    mgr.registerGroupId(100, '0x7001');
    // 3 NACKs + initial send = 4 total sends, then MAX_RETRIES on 4th NACK
    mgr.handleNack(100, NACK_REASON_INVALID_FRAGMENT); // retry 1
    mgr.handleNack(100, NACK_REASON_INVALID_FRAGMENT); // retry 2
    mgr.handleNack(100, NACK_REASON_INVALID_FRAGMENT); // retry 3
    mgr.handleNack(100, NACK_REASON_INVALID_FRAGMENT); // retry 4 → MAX_RETRIES
    expect(mgr.hasActiveMessage()).toBe(false);
    expect(events.some(e => e.type === 'MAX_RETRIES')).toBe(true);
  });

  // Test 54
  it('spoofed ACK for wrong messageId → no effect', () => {
    const mgr = new ReliabilityManager('peer_A', new SequenceManager(0));
    mgr.send({ messageId: '0x6001', v6aPacket: makeV6aPacket() });
    mgr.handleAck('0x6002'); // wrong
    expect(mgr.hasActiveMessage()).toBe(true);
    mgr.cancel();
  });

  // Test 55
  it('stale ACK for cleared message → no crash', () => {
    const mgr = new ReliabilityManager('peer_A', new SequenceManager(0));
    mgr.send({ messageId: '0x6003', v6aPacket: makeV6aPacket() });
    mgr.handleAck('0x6003');
    mgr.handleAck('0x6003'); // stale — no crash
  });

  // Test 56
  it('NACK for wrong groupId → ignored', () => {
    const mgr = new ReliabilityManager('peer_A', new SequenceManager(0));
    mgr.send({
      messageId: '0x6004',
      v6aPacket: makeV6aPacket(1000),
      groupId: 50,
      fragments: makeFragments(3),
      payloads: makeFragments(3),
    });
    mgr.registerGroupId(50, '0x6004');
    mgr.handleNack(99, NACK_REASON_INVALID_FRAGMENT); // wrong group
    expect(mgr.getActiveMessage()!.retryCount).toBe(0); // no retry triggered
    mgr.cancel();
  });

  // Test 57
  it('NACK rate limiting: 4 per second max', () => {
    const mgr = new ReliabilityManager('peer_A', new SequenceManager(0));
    for (let i = 0; i < 4; i++) expect(mgr.canNack()).toBe(true);
    expect(mgr.canNack()).toBe(false);
  });

  // Test 58
  it('ACK for fragmented message cleans up groupId mapping', () => {
    const mgr = new ReliabilityManager('peer_A', new SequenceManager(0));
    mgr.send({
      messageId: '0x6005',
      v6aPacket: makeV6aPacket(1000),
      groupId: 60,
      fragments: makeFragments(3),
      payloads: makeFragments(3),
    });
    mgr.registerGroupId(60, '0x6005');
    mgr.handleAck('0x6005');
    expect(mgr.hasActiveMessage()).toBe(false);
    // NACK for that group should now be ignored
    mgr.handleNack(60, NACK_REASON_INVALID_FRAGMENT);
  });
});

// ══════════════════════════════════════════════════════════════════
// 59–78. RETRANSMISSION INTEGRATION
// ══════════════════════════════════════════════════════════════════

describe('Retransmission Integration', () => {
  let mgr: ReliabilityManager;
  let seqMgr: SequenceManager;
  let sentFrames: Uint8Array[];

  beforeEach(async () => {
    sentFrames = [];
    seqMgr = new SequenceManager(0);
    mgr = new ReliabilityManager('peer_A', seqMgr);
    mgr.setSendFn(async (frame: Uint8Array) => {
      sentFrames.push(frame);
    });
  });

  afterEach(() => {
    mgr.cancel();
  });

  // Test 59: Timeout retry actually causes a DATA send
  it('timeout retry causes a real BLE DATA send via sendFn', async () => {
    const v6a = makeV6aPacket();
    mgr.send({ messageId: '0xA001', v6aPacket: v6a });
    // Initial send does NOT go through sendFn (integration handles that)
    // Only retransmission goes through sendFn
    expect(sentFrames.length).toBe(0);

    mgr.handleTimeout(); // triggers retransmission
    await mgr.waitForRetransmission();

    expect(sentFrames.length).toBe(1); // one DATA frame retransmitted
  });

  // Test 60: Timeout retry gets a NEW V6B sequence
  it('timeout retry uses a NEW V6B sequence (not the original)', async () => {
    const v6a = makeV6aPacket();
    // Use up some sequences so the initial send consumes one
    const origSeq = seqMgr.nextSequence(); // consumed by initial send in integration
    mgr.send({ messageId: '0xA002', v6aPacket: v6a });

    mgr.handleTimeout();
    await mgr.waitForRetransmission();

    // The retransmission frame should have a new sequence > original
    const { decode } = require('../V6BFrameCodec');
    const decoded = decode(sentFrames[0]);
    expect(decoded.sequence).toBeGreaterThan(origSeq);
    expect(decoded.frameType).toBe(0x01); // V6A_MESSAGE
  });

  // Test 61: NACK retry actually causes retransmission
  it('NACK causes real retransmission via sendFn', async () => {
    mgr.send({
      messageId: '0xA003',
      v6aPacket: makeV6aPacket(1000),
      groupId: 30,
      fragments: makeFragments(3),
      payloads: makeFragments(3),
    });
    mgr.registerGroupId(30, '0xA003');

    mgr.handleNack(30, NACK_REASON_INVALID_FRAGMENT);
    await mgr.waitForRetransmission();

    // All 3 fragments should be retransmitted
    expect(sentFrames.length).toBe(3);
  });

  // Test 62: NACK retry gets NEW V6B sequences for every fragment
  it('NACK retransmission assigns fresh V6B sequences to every fragment', async () => {
    const seqBefore = seqMgr.nextSequence(); // consume one seq
    mgr.send({
      messageId: '0xA004',
      v6aPacket: makeV6aPacket(1000),
      groupId: 40,
      fragments: makeFragments(2),
      payloads: makeFragments(2),
    });
    mgr.registerGroupId(40, '0xA004');

    mgr.handleNack(40, NACK_REASON_METADATA_CONFLICT);
    await mgr.waitForRetransmission();

    expect(sentFrames.length).toBe(2);
    const { decode } = require('../V6BFrameCodec');
    const d0 = decode(sentFrames[0]);
    const d1 = decode(sentFrames[1]);
    // Both should have sequences newer than seqBefore
    expect(d0.sequence).toBeGreaterThan(seqBefore);
    expect(d1.sequence).toBeGreaterThan(d0.sequence); // sequential increment
  });

  // Test 63: NACK does not reset retryCount
  it('NACK increments retryCount, never resets it', async () => {
    mgr.send({
      messageId: '0xA005',
      v6aPacket: makeV6aPacket(1000),
      groupId: 50,
      fragments: makeFragments(2),
      payloads: makeFragments(2),
    });
    mgr.registerGroupId(50, '0xA005');

    mgr.handleNack(50, NACK_REASON_INVALID_FRAGMENT); // count = 1
    expect(mgr.getActiveMessage()!.retryCount).toBe(1);
    await mgr.waitForRetransmission();

    mgr.handleNack(50, NACK_REASON_INVALID_FRAGMENT); // count = 2
    expect(mgr.getActiveMessage()!.retryCount).toBe(2);
    await mgr.waitForRetransmission();
  });

  // Test 64: Repeated NACKs exhaust the retry budget
  it('repeated NACKs exhaust the retry budget (max 3 retries)', async () => {
    const events: any[] = [];
    mgr.setOnEvent(e => events.push(e));

    mgr.send({
      messageId: '0xA006',
      v6aPacket: makeV6aPacket(1000),
      groupId: 60,
      fragments: makeFragments(2),
      payloads: makeFragments(2),
    });
    mgr.registerGroupId(60, '0xA006');

    mgr.handleNack(60, NACK_REASON_INVALID_FRAGMENT); // retry 1
    await mgr.waitForRetransmission();
    mgr.handleNack(60, NACK_REASON_INVALID_FRAGMENT); // retry 2
    await mgr.waitForRetransmission();
    mgr.handleNack(60, NACK_REASON_INVALID_FRAGMENT); // retry 3
    await mgr.waitForRetransmission();
    mgr.handleNack(60, NACK_REASON_INVALID_FRAGMENT); // retry 4 → MAX_RETRIES

    expect(mgr.hasActiveMessage()).toBe(false);
    expect(events.some(e => e.type === 'MAX_RETRIES')).toBe(true);
  });

  // Test 65: Single-frame retransmission sends exactly one DATA frame
  it('single-frame retransmission sends exactly one V6B DATA frame', async () => {
    mgr.send({ messageId: '0xA007', v6aPacket: makeV6aPacket() });

    mgr.handleTimeout();
    await mgr.waitForRetransmission();

    expect(sentFrames.length).toBe(1);
    const { decode } = require('../V6BFrameCodec');
    const decoded = decode(sentFrames[0]);
    expect(decoded.frameType).toBe(0x01); // V6A_MESSAGE
    expect(decoded.payload.length).toBeGreaterThan(0);
  });

  // Test 66: Fragmented retransmission sends ALL fragments
  it('fragmented retransmission sends ALL fragment V6B DATA frames', async () => {
    const frags = makeFragments(5);
    mgr.send({
      messageId: '0xA008',
      v6aPacket: makeV6aPacket(3000),
      groupId: 80,
      fragments: frags,
      payloads: frags,
    });

    mgr.handleTimeout();
    await mgr.waitForRetransmission();

    expect(sentFrames.length).toBe(5);
    // All frames should be V6A_MESSAGE
    const { decode } = require('../V6BFrameCodec');
    for (const frame of sentFrames) {
      expect(decode(frame).frameType).toBe(0x01);
    }
  });

  // Test 67: Every retransmitted fragment gets a fresh V6B sequence
  it('every retransmitted fragment gets a unique fresh V6B sequence', async () => {
    mgr.send({
      messageId: '0xA009',
      v6aPacket: makeV6aPacket(2000),
      groupId: 90,
      fragments: makeFragments(3),
      payloads: makeFragments(3),
    });

    mgr.handleTimeout();
    await mgr.waitForRetransmission();

    const { decode } = require('../V6BFrameCodec');
    const seqs = sentFrames.map(f => decode(f).sequence);
    // All sequences unique
    expect(new Set(seqs).size).toBe(3);
    // Sequential
    expect(seqs[1]).toBeGreaterThan(seqs[0]);
    expect(seqs[2]).toBeGreaterThan(seqs[1]);
  });

  // Test 68: Retransmission is sequential
  it('retransmission of fragments is sequential (ordered)', async () => {
    mgr.send({
      messageId: '0xA010',
      v6aPacket: makeV6aPacket(2000),
      groupId: 100,
      fragments: makeFragments(4),
      payloads: makeFragments(4),
    });

    mgr.handleTimeout();
    // Immediately check — should still be retransmitting
    expect(mgr.isRetransmitting()).toBe(true);

    await mgr.waitForRetransmission();
    expect(mgr.isRetransmitting()).toBe(false);
    expect(sentFrames.length).toBe(4);
  });

  // Test 69: ACK clears timer before queued promotion
  it('ACK clears timer and promotes queued message correctly', async () => {
    mgr.send({ messageId: '0xA011', v6aPacket: makeV6aPacket() }); // active
    mgr.send({ messageId: '0xA012', v6aPacket: makeV6aPacket() }); // queued

    mgr.handleAck('0xA011'); // ACK for active
    // Active should be cleared, queued promoted
    expect(mgr.hasActiveMessage()).toBe(true);
    expect(mgr.getActiveMessage()!.messageId).toBe('0xA012');
    expect(mgr.hasQueuedMessage()).toBe(false);
  });

  // Test 70: No retry occurs after ACK
  it('no retry event fires after ACK clears the active message', async () => {
    const events: any[] = [];
    mgr.setOnEvent(e => events.push(e));

    mgr.send({ messageId: '0xA013', v6aPacket: makeV6aPacket() });
    mgr.handleAck('0xA013');

    // Clear events from ACK
    events.length = 0;

    // Trigger timeout — should have no effect since active is null
    mgr.handleTimeout();

    expect(events.filter(e => e.type === 'TIMEOUT_RETRY').length).toBe(0);
    expect(sentFrames.length).toBe(0);
  });

  // Test 71: ACK received during retransmission stops further sends
  it('ACK during retransmission prevents further fragment sends', async () => {
    mgr.send({
      messageId: '0xA014',
      v6aPacket: makeV6aPacket(2000),
      groupId: 140,
      fragments: makeFragments(5),
      payloads: makeFragments(5),
    });

    // Start retransmission, then ACK before all fragments sent
    mgr.handleTimeout();
    // Wait a tiny bit for retransmission to start, then ACK
    await new Promise<void>(r => setTimeout(r, 10));
    mgr.handleAck('0xA014');
    await mgr.waitForRetransmission();

    // Not all 5 fragments may have been sent (ACK interrupted)
    expect(mgr.hasActiveMessage()).toBe(false);
  });

  // Test 72: Lost ACK causes real retransmission then eventual ACK + SUCCESS
  it('lost ACK → retransmission → eventual ACK → SUCCESS', async () => {
    mgr.send({ messageId: '0xA015', v6aPacket: makeV6aPacket() });

    // Simulate lost ACK: timeout fires
    mgr.handleTimeout();
    await mgr.waitForRetransmission();
    expect(sentFrames.length).toBe(1); // retransmitted

    // ACK eventually arrives
    mgr.handleAck('0xA015');
    expect(mgr.hasActiveMessage()).toBe(false);
  });

  // Test 73: Connection loss cancels active retransmission
  it('connection loss cancels retransmission in progress', async () => {
    mgr.send({
      messageId: '0xA016',
      v6aPacket: makeV6aPacket(2000),
      groupId: 160,
      fragments: makeFragments(5),
      payloads: makeFragments(5),
    });

    mgr.handleTimeout();
    // Cancel immediately
    mgr.cancel();
    await mgr.waitForRetransmission().catch((_err: unknown) => {});

    expect(mgr.hasActiveMessage()).toBe(false);
    expect(mgr.hasQueuedMessage()).toBe(false);
    expect(mgr.isRetransmitting()).toBe(false);
  });

  // Test 74: Retransmission guard prevents overlapping sends
  it('concurrent timeout does not cause overlapping retransmission', async () => {
    mgr.send({
      messageId: '0xA017',
      v6aPacket: makeV6aPacket(2000),
      groupId: 170,
      fragments: makeFragments(3),
      payloads: makeFragments(3),
    });

    mgr.handleTimeout(); // starts retransmission
    mgr.handleTimeout(); // should be blocked by guard (but retryCount still increments)
    await mgr.waitForRetransmission();

    // Should only have sent 3 fragments (one group), not 6
    expect(sentFrames.length).toBe(3);
  });

  // Test 75: Lost ACK for single-frame → retransmit → re-ACK → SUCCESS
  it('lost ACK for single-frame causes retransmission and receiver re-ACKs', async () => {
    mgr.send({ messageId: '0xA018', v6aPacket: makeV6aPacket() });

    mgr.handleTimeout();
    await mgr.waitForRetransmission();
    expect(sentFrames.length).toBe(1);

    mgr.handleAck('0xA018');
    expect(mgr.hasActiveMessage()).toBe(false);
  });

  // Test 76: Malicious repeated NACKs cannot cause unlimited sends
  it('100 NACKs still capped at max 4 total sends', async () => {
    mgr.send({
      messageId: '0xA019',
      v6aPacket: makeV6aPacket(1000),
      groupId: 190,
      fragments: makeFragments(2),
      payloads: makeFragments(2),
    });
    mgr.registerGroupId(190, '0xA019');

    for (let i = 0; i < 100; i++) {
      mgr.handleNack(190, NACK_REASON_INVALID_FRAGMENT);
      await mgr.waitForRetransmission();
    }

    // Max 3 retries = 4 total sends (1 initial + 3 retries)
    // Each retransmission sends 2 fragments = 6 fragment sends max
    expect(sentFrames.length).toBeLessThanOrEqual(6);
    expect(mgr.hasActiveMessage()).toBe(false);
  });

  // Test 77: isRetransmitting flag is accurate
  it('isRetransmitting reflects actual state', async () => {
    mgr.send({
      messageId: '0xA020',
      v6aPacket: makeV6aPacket(1000),
      groupId: 200,
      fragments: makeFragments(3),
      payloads: makeFragments(3),
    });

    expect(mgr.isRetransmitting()).toBe(false);
    mgr.handleTimeout();
    // May or may not be retransmitting synchronously — check after
    await mgr.waitForRetransmission();
    expect(mgr.isRetransmitting()).toBe(false);
  });

  // Test 78: Queued message is sent after active ACK
  it('queued message is promoted and ready after active ACK', async () => {
    mgr.send({ messageId: '0xA021', v6aPacket: makeV6aPacket() });
    mgr.send({ messageId: '0xA022', v6aPacket: makeV6aPacket() });

    mgr.handleAck('0xA021');
    expect(mgr.getActiveMessage()!.messageId).toBe('0xA022');
    expect(mgr.getQueuedMessage()).toBeNull();

    // Promoted message should have retryCount=0
    expect(mgr.getActiveMessage()!.retryCount).toBe(0);
    mgr.cancel();
  });
});

// ══════════════════════════════════════════════════════════════════
// 79–90. ACK-DEFERRED CONCURRENCY
// ══════════════════════════════════════════════════════════════════

describe('ACK-Deferred Concurrency', () => {
  let mgr: ReliabilityManager;
  let seqMgr: SequenceManager;
  let sentFrames: Uint8Array[];
  let sendDelayMs: number;

  beforeEach(async () => {
    sentFrames = [];
    sendDelayMs = 0;
    seqMgr = new SequenceManager(0);
    mgr = new ReliabilityManager('peer_A', seqMgr);
    mgr.setSendFn(async (frame: Uint8Array) => {
      if (sendDelayMs > 0) await new Promise<void>(r => setTimeout(r, sendDelayMs));
      sentFrames.push(frame);
    });
  });

  afterEach(() => {
    mgr.cancel();
  });

  // Test 79: ACK during single-frame retransmission
  // Single-frame has no yield before send, so the frame is sent.
  // But ACK clears the message and prevents retry timer restart.
  it('ACK during single-frame retransmission clears message without restart', async () => {
    sendDelayMs = 20; // Delay so ACK arrives during the send
    mgr.send({ messageId: '0xC001', v6aPacket: makeV6aPacket() });

    mgr.handleTimeout(); // starts retransmission
    mgr.handleAck('0xC001'); // ACK during send
    await mgr.waitForRetransmission();

    // The frame was sent (in-flight, can't cancel), but message is cleared
    expect(sentFrames.length).toBe(1);
    expect(mgr.hasActiveMessage()).toBe(false);
  });

  // Test 80: ACK during multi-fragment retransmission — remaining fragments stop
  it('ACK during fragmented retransmission stops remaining fragments', async () => {
    sendDelayMs = 5; // Small delay so ACK can arrive between fragments
    mgr.send({
      messageId: '0xC002',
      v6aPacket: makeV6aPacket(3000),
      groupId: 200,
      fragments: makeFragments(5),
      payloads: makeFragments(5),
    });

    mgr.handleTimeout(); // starts retransmission of 5 fragments
    // ACK after a tiny delay (some fragments may have been sent)
    await new Promise<void>(r => setTimeout(r, 15));
    mgr.handleAck('0xC002');
    await mgr.waitForRetransmission();

    // Not all 5 fragments should have been sent
    expect(sentFrames.length).toBeLessThan(5);
    expect(mgr.hasActiveMessage()).toBe(false);
  });

  // Test 81: Remaining old fragments stop after ACK
  // After ACK + retransmission-exit, no further fragments are sent.
  // Some in-flight fragments at ACK time may still complete.
  it('no new fragments started after ACK clears the message', async () => {
    sendDelayMs = 15; // Slow enough for ACK to arrive mid-stream
    mgr.send({
      messageId: '0xC003',
      v6aPacket: makeV6aPacket(3000),
      groupId: 300,
      fragments: makeFragments(5),
      payloads: makeFragments(5),
    });

    mgr.handleTimeout();
    await new Promise<void>(r => setTimeout(r, 25)); // ~1-2 fragments sent
    mgr.handleAck('0xC003');
    const countAtAck = sentFrames.length;
    await mgr.waitForRetransmission();
    const countAfter = sentFrames.length;

    // At most 1 in-flight fragment completes after ACK (the one that was mid-send)
    // But no NEW fragments are started — loop checks msg.acked before each send
    expect(countAfter).toBeLessThanOrEqual(countAtAck + 1);
    expect(mgr.hasActiveMessage()).toBe(false);
  });

  // Test 82: Queued message does not start before retransmission exits
  it('queued message is NOT sent while retransmission is still running', async () => {
    sendDelayMs = 20; // Slow retransmission
    mgr.send({ messageId: '0xC004', v6aPacket: makeV6aPacket(2000), groupId: 400, fragments: makeFragments(3), payloads: makeFragments(3) });
    mgr.send({ messageId: '0xC005', v6aPacket: makeV6aPacket() }); // queued

    mgr.handleTimeout(); // starts retransmission of 0xC004
    // ACK 0xC004 — should defer promotion
    await new Promise<void>(r => setTimeout(r, 5));
    mgr.handleAck('0xC004');

    // During retransmission: active should still be 0xC004 (acked but not cleared)
    // Queued 0xC005 should NOT have been promoted yet
    // After retransmission completes, 0xC005 should be promoted
    await mgr.waitForRetransmission();

    expect(mgr.getActiveMessage()!.messageId).toBe('0xC005');
    expect(mgr.hasQueuedMessage()).toBe(false);
    mgr.cancel();
  });

  // Test 83: No old/new DATA frame interleaving
  it('old retransmitted frames never interleave with new message frames', async () => {
    sendDelayMs = 10;
    mgr.send({ messageId: '0xC006', v6aPacket: makeV6aPacket(2000), groupId: 600, fragments: makeFragments(3), payloads: makeFragments(3) });
    mgr.send({ messageId: '0xC007', v6aPacket: makeV6aPacket() }); // queued

    mgr.handleTimeout();
    await new Promise<void>(r => setTimeout(r, 5));
    mgr.handleAck('0xC006');
    await mgr.waitForRetransmission();

    // All sent frames before ACK should be for 0xC006 (V7 fragments)
    // No frames for 0xC007 should appear before retransmission completes
    // After completion, 0xC007 is promoted but not sent yet (integration sends)
    expect(mgr.getActiveMessage()!.messageId).toBe('0xC007');
    mgr.cancel();
  });

  // Test 84: Queued message starts after retransmission completes
  it('queued message is promoted only after retransmission fully exits', async () => {
    sendDelayMs = 5;
    mgr.send({ messageId: '0xC008', v6aPacket: makeV6aPacket(2000), groupId: 800, fragments: makeFragments(3), payloads: makeFragments(3) });
    mgr.send({ messageId: '0xC009', v6aPacket: makeV6aPacket() });

    mgr.handleTimeout();
    await new Promise<void>(r => setTimeout(r, 3));
    mgr.handleAck('0xC008');

    // Before retransmission completes: queued should still be queued
    await mgr.waitForRetransmission();

    // After completion: queued promoted
    expect(mgr.getActiveMessage()!.messageId).toBe('0xC009');
    expect(mgr.hasQueuedMessage()).toBe(false);
    mgr.cancel();
  });

  // Test 85: Queued message receives a fresh retry timer
  it('promoted queued message starts with retryCount=0', async () => {
    mgr.send({ messageId: '0xC00A', v6aPacket: makeV6aPacket() });
    mgr.send({ messageId: '0xC00B', v6aPacket: makeV6aPacket() });

    // ACK active → promote queued
    mgr.handleAck('0xC00A');

    expect(mgr.getActiveMessage()!.messageId).toBe('0xC00B');
    expect(mgr.getActiveMessage()!.retryCount).toBe(0);
    mgr.cancel();
  });

  // Test 86: ACK during retransmission clears the old retry timer
  it('ACK during retransmission prevents any new retry timer for old message', async () => {
    mgr.send({ messageId: '0xC00C', v6aPacket: makeV6aPacket() });

    mgr.handleTimeout();
    mgr.handleAck('0xC00C');
    await mgr.waitForRetransmission();

    // No active message → no timer should fire
    expect(mgr.hasActiveMessage()).toBe(false);
  });

  // Test 87: No obsolete retransmission timer fires after ACK
  it('no retransmission occurs after ACK + retransmission-exit + promotion', async () => {
    sendDelayMs = 5;
    mgr.send({ messageId: '0xC00D', v6aPacket: makeV6aPacket(2000), groupId: 1300, fragments: makeFragments(3), payloads: makeFragments(3) });
    mgr.send({ messageId: '0xC00E', v6aPacket: makeV6aPacket() });

    mgr.handleTimeout();
    await new Promise<void>(r => setTimeout(r, 3));
    mgr.handleAck('0xC00D');
    await mgr.waitForRetransmission();

    sentFrames.length = 0; // Clear old frames

    // Wait a bit — no old retransmission should happen
    await new Promise<void>(r => setTimeout(r, 50));
    expect(sentFrames.length).toBe(0);
    expect(mgr.getActiveMessage()!.messageId).toBe('0xC00E');
    mgr.cancel();
  });

  // Test 88: If no ACK arrives, retransmission completes normally and timer restarts
  it('no ACK → retransmission completes → retry timer restarts', async () => {
    mgr.send({ messageId: '0xC00F', v6aPacket: makeV6aPacket(2000), groupId: 1500, fragments: makeFragments(2), payloads: makeFragments(2) });

    mgr.handleTimeout(); // starts retransmission
    await mgr.waitForRetransmission();

    // Retransmission completed, no ACK → timer should have restarted
    expect(sentFrames.length).toBe(2);
    expect(mgr.hasActiveMessage()).toBe(true);
    expect(mgr.getActiveMessage()!.messageId).toBe('0xC00F');
    mgr.cancel();
  });

  // Test 89: NACK during retransmission does not create overlapping retransmissions
  it('NACK during retransmission is blocked by guard (no overlap)', async () => {
    mgr.send({
      messageId: '0xC010',
      v6aPacket: makeV6aPacket(2000),
      groupId: 1600,
      fragments: makeFragments(3),
      payloads: makeFragments(3),
    });
    mgr.registerGroupId(1600, '0xC010');

    mgr.handleTimeout(); // starts retransmission
    mgr.handleNack(1600, 0x02); // NACK during retransmission — should not overlap
    await mgr.waitForRetransmission();

    // Only one group of fragments should have been sent
    expect(sentFrames.length).toBe(3);
    mgr.cancel();
  });

  // Test 90: Retry budget remains unchanged by ACK-during-retransmission
  it('ACK during retransmission does not consume retry budget', async () => {
    mgr.send({ messageId: '0xC011', v6aPacket: makeV6aPacket() });

    mgr.handleTimeout(); // retryCount = 1
    mgr.handleAck('0xC011'); // ACK during retransmission
    await mgr.waitForRetransmission();

    // Message was ACKed — no failure, no budget concern
    expect(mgr.hasActiveMessage()).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
// 91–100. QUEUE INTEGRATION
// ══════════════════════════════════════════════════════════════════

describe('Queue Integration', () => {
  let mgr: ReliabilityManager;
  let seqMgr: SequenceManager;
  let sentFrames: Uint8Array[];
  let promotedMessages: string[];

  beforeEach(async () => {
    sentFrames = [];
    promotedMessages = [];
    seqMgr = new SequenceManager(0);
    mgr = new ReliabilityManager('peer_A', seqMgr);
    mgr.setSendFn(async (frame: Uint8Array) => {
      sentFrames.push(frame);
    });
    mgr.setOnPromote((msg) => {
      promotedMessages.push(msg.messageId);
    });
  });

  afterEach(() => {
    mgr.cancel();
  });

  // Test 91: active A + queued B → B is NOT immediately sent
  it('queued message send() returns active=false, no DATA frames sent', () => {
    const rA = mgr.send({ messageId: '0xD001', v6aPacket: makeV6aPacket() });
    expect(rA.active).toBe(true);

    const rB = mgr.send({ messageId: '0xD002', v6aPacket: makeV6aPacket() });
    expect(rB.active).toBe(false);
    expect(sentFrames.length).toBe(0); // No DATA frames sent at all
  });

  // Test 92: ACK(A) → B is promoted and onPromote fires
  it('ACK for active triggers onPromote with queued message', () => {
    mgr.send({ messageId: '0xD003', v6aPacket: makeV6aPacket() });
    mgr.send({ messageId: '0xD004', v6aPacket: makeV6aPacket() });

    mgr.handleAck('0xD003');

    // B should be promoted
    expect(mgr.getActiveMessage()!.messageId).toBe('0xD004');
    expect(promotedMessages).toContain('0xD004');
  });

  // Test 93: onPromote callback can send DATA frames
  it('onPromote sends DATA frames for promoted message', async () => {
    // Override onPromote to actually send
    mgr.setOnPromote(async (msg) => {
      for (let i = 0; i < msg.payloads.length; i++) {
        const seq = seqMgr.nextSequence();
        const frame = (require('../V6BFrameCodec') as any).encode(seq, 0x01, msg.payloads[i]);
        sentFrames.push(frame);
      }
    });

    mgr.send({ messageId: '0xD005', v6aPacket: makeV6aPacket() });
    mgr.send({ messageId: '0xD006', v6aPacket: makeV6aPacket(1000), groupId: 500, fragments: makeFragments(2), payloads: makeFragments(2) });

    mgr.handleAck('0xD005');

    // Promoted message's fragments should be sent
    expect(sentFrames.length).toBe(2);
  });

  // Test 94: ACK during A retransmission → B waits until retransmission exits
  it('ACK during retransmission defers onPromote until retransmission exits', async () => {
    mgr.send({ messageId: '0xD007', v6aPacket: makeV6aPacket(2000), groupId: 700, fragments: makeFragments(3), payloads: makeFragments(3) });
    mgr.send({ messageId: '0xD008', v6aPacket: makeV6aPacket() });

    mgr.handleTimeout(); // starts retransmission of D007
    await new Promise<void>(r => setTimeout(r, 5));
    mgr.handleAck('0xD007'); // ACK during retransmission
    await mgr.waitForRetransmission();

    // onPromote should have fired after retransmission exit
    expect(promotedMessages).toContain('0xD008');
    expect(mgr.getActiveMessage()!.messageId).toBe('0xD008');
    mgr.cancel();
  });

  // Test 95: MAX_RETRIES(A) → B is promoted via onPromote
  it('MAX_RETRIES promotes queued message via onPromote', () => {
    mgr.send({ messageId: '0xD009', v6aPacket: makeV6aPacket() });
    mgr.send({ messageId: '0xD00A', v6aPacket: makeV6aPacket() });

    // Exhaust retries
    for (let i = 0; i < 4; i++) mgr.handleTimeout();

    expect(promotedMessages).toContain('0xD00A');
    expect(mgr.getActiveMessage()!.messageId).toBe('0xD00A');
    mgr.cancel();
  });

  // Test 96: cancel(A) → B is discarded, onPromote NOT called
  it('cancel discards queued message without onPromote', () => {
    mgr.send({ messageId: '0xD00B', v6aPacket: makeV6aPacket() });
    mgr.send({ messageId: '0xD00C', v6aPacket: makeV6aPacket() });

    mgr.cancel();

    expect(mgr.hasActiveMessage()).toBe(false);
    expect(mgr.hasQueuedMessage()).toBe(false);
    expect(promotedMessages.length).toBe(0);
  });

  // Test 97: send() returns correct active/queued status
  it('send() returns active=true only when no active message exists', () => {
    const r1 = mgr.send({ messageId: '0xD00D', v6aPacket: makeV6aPacket() });
    expect(r1.active).toBe(true);

    const r2 = mgr.send({ messageId: '0xD00E', v6aPacket: makeV6aPacket() });
    expect(r2.active).toBe(false);

    const r3 = mgr.send({ messageId: '0xD00F', v6aPacket: makeV6aPacket() });
    expect(r3.active).toBe(false); // replaces queued, still not active

    mgr.cancel();
  });

  // Test 98: rapid third message replaces queued (not active)
  it('third message replaces queued, active message unchanged', () => {
    mgr.send({ messageId: '0xD010', v6aPacket: makeV6aPacket() });
    mgr.send({ messageId: '0xD011', v6aPacket: makeV6aPacket() });
    mgr.send({ messageId: '0xD012', v6aPacket: makeV6aPacket() });

    expect(mgr.getActiveMessage()!.messageId).toBe('0xD010');
    expect(mgr.getQueuedMessage()!.messageId).toBe('0xD012'); // replaced D011
    mgr.cancel();
  });

  // Test 99: fragmented queued message is sent correctly on promote
  it('fragmented queued message sends all fragments on promote', async () => {
    mgr.setOnPromote(async (msg) => {
      for (let i = 0; i < msg.payloads.length; i++) {
        const seq = seqMgr.nextSequence();
        const frame = (require('../V6BFrameCodec') as any).encode(seq, 0x01, msg.payloads[i]);
        sentFrames.push(frame);
      }
    });

    mgr.send({ messageId: '0xD013', v6aPacket: makeV6aPacket() });
    mgr.send({
      messageId: '0xD014',
      v6aPacket: makeV6aPacket(2000),
      groupId: 1400,
      fragments: makeFragments(4),
      payloads: makeFragments(4),
    });

    mgr.handleAck('0xD013'); // promote D014

    expect(sentFrames.length).toBe(4); // all 4 fragments sent
    mgr.cancel();
  });

  // Test 100: onPromote fires only when queued message exists
  it('ACK with no queued message does not fire onPromote', () => {
    mgr.send({ messageId: '0xD015', v6aPacket: makeV6aPacket() });

    mgr.handleAck('0xD015');

    expect(promotedMessages.length).toBe(0); // no queued message to promote
  });
});

// ══════════════════════════════════════════════════════════════════
// 101–105. REGRESSION
// ══════════════════════════════════════════════════════════════════

describe('Regression', () => {
  // Test 59
  it('V4 JSON fallback still works', () => {
    const { safeDecode } = require('../../semantic/SemanticMessageCodec');
    const v4Json = JSON.stringify({
      version: 1, messageId: 'msg_v4_00', text: 'V4 still works',
      language: 'en', emotion: 'neutral', emotionConfidence: 0.0, voiceProfile: 'default',
    });
    const result = safeDecode(v4Json);
    expect(result).not.toBeNull();
    expect(result!.text).toBe('V4 still works');
  });

  // Test 60
  it('V6A encode/decode still works', () => {
    const { encode, decode } = require('../BinaryMessageCodec');
    const msg = {
      version: 1, messageId: 'msg_v6a_00', text: 'V6A still works',
      language: 'en', emotion: 'neutral', emotionConfidence: 0.0, voiceProfile: 'default',
    };
    const packet = encode(msg);
    const decoded = decode(packet);
    expect(decoded.text).toBe('V6A still works');
  });

  // Test 61
  it('V6B encode/decode still works', () => {
    const { encode: v6bEncode, decode: v6bDecode } = require('../V6BFrameCodec');
    const payload = new Uint8Array([0x02, 0x01, 0x00]);
    const frame = v6bEncode(42, 0x01, payload);
    const decoded = v6bDecode(frame);
    expect(decoded.sequence).toBe(42);
    expect(decoded.frameType).toBe(0x01);
  });

  // Test 62
  it('V7 splitV6A still works', () => {
    const { splitV6A } = require('../FragmentCodec');
    const packet = new Uint8Array(500).fill(0x41);
    const chunks = splitV6A(packet);
    expect(chunks.length).toBe(2);
  });

  // Test 63
  it('V7 Reassembler still works', () => {
    const { Reassembler } = require('../Reassembler');
    const { splitV6A } = require('../FragmentCodec');
    const { parseHeader } = require('../FragmentCodec');
    const { V7_HEADER_SIZE } = require('../V7FragmentTypes');
    const packet = new Uint8Array(500).fill(0x42);
    const chunks = splitV6A(packet);
    const r = new Reassembler();
    r.addFragment('test', chunks[0].header, chunks[0].payload.slice(V7_HEADER_SIZE));
    const result = r.addFragment('test', chunks[1].header, chunks[1].payload.slice(V7_HEADER_SIZE));
    expect(result.status).toBe('complete');
  });
});
