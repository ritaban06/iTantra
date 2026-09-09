/**
 * V9A BitChat TTLManager — Tests
 */

import { TTLManager } from '../mesh/TTLManager';
import { DEFAULT_TTL, MAX_TTL } from '../core/BitChatConstants';

describe('TTLManager', () => {
  it('createInitialTTL returns default', () => {
    expect(TTLManager.createInitialTTL()).toBe(DEFAULT_TTL);
  });

  it('default TTL equals MAX_TTL', () => {
    expect(DEFAULT_TTL).toBe(MAX_TTL);
  });

  it('canRelay with TTL > 0', () => {
    expect(TTLManager.canRelay(5)).toBe(true);
    expect(TTLManager.canRelay(1)).toBe(true);
  });

  it('cannotRelay with TTL = 0', () => {
    expect(TTLManager.canRelay(0)).toBe(false);
  });

  it('cannotRelay with invalid TTL', () => {
    expect(TTLManager.canRelay(-1)).toBe(false);
    expect(TTLManager.canRelay(256)).toBe(false);
    expect(TTLManager.canRelay(1.5)).toBe(false);
  });

  it('decrement reduces by 1', () => {
    expect(TTLManager.decrement(5)).toBe(4);
    expect(TTLManager.decrement(1)).toBe(0);
  });

  it('decrement never goes below 0', () => {
    expect(TTLManager.decrement(0)).toBe(0);
  });

  it('decrement throws on invalid TTL', () => {
    expect(() => TTLManager.decrement(-1)).toThrow();
    expect(() => TTLManager.decrement(256)).toThrow();
    expect(() => TTLManager.decrement(1.5)).toThrow();
  });

  it('chain: 5 → 4 → 3 → 2 → 1 → 0', () => {
    let ttl = TTLManager.createInitialTTL();
    for (let i = 4; i >= 0; i--) {
      ttl = TTLManager.decrement(ttl);
      expect(ttl).toBe(i);
    }
    expect(TTLManager.canRelay(ttl)).toBe(false);
  });
});
