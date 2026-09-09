/**
 * MVP Hardening — splitV6AForBudget tests (mesh-path V7 fragmentation)
 *
 * The mesh path wraps V7 fragments inside BITCHAT envelopes, so each V6B
 * payload must carry V7 header + chunk within
 * V6B_MAX_PAYLOAD_SIZE − BITCHAT_HEADER_SIZE = 471 bytes total.
 */

import {
  splitV6AForBudget,
  parseHeader,
  resetGroupIdCounter,
} from '../FragmentCodec';
import { Reassembler } from '../Reassembler';
import {
  V7_MARKER,
  V7_HEADER_SIZE,
  MAX_V6A_LENGTH,
  V7FragmentError,
} from '../V7FragmentTypes';

const MESH_CHUNK_BUDGET = 499 - 28; // 471 total bytes per mesh V6B payload

describe('splitV6AForBudget', () => {
  beforeEach(() => {
    resetGroupIdCounter();
  });

  it('packets within budget are not fragmented (empty array)', () => {
    // Budget 471 − 9 header = 462 data bytes per fragment.
    const small = new Uint8Array(462);
    expect(splitV6AForBudget(small, MESH_CHUNK_BUDGET)).toEqual([]);
  });

  it('packets one byte over the data budget produce 2 fragments', () => {
    const v6a = new Uint8Array(463);
    const frags = splitV6AForBudget(v6a, MESH_CHUNK_BUDGET);
    expect(frags.length).toBe(2);
    expect(frags[0].header.totalFragments).toBe(2);
    expect(frags[0].payload.length).toBe(V7_HEADER_SIZE + 462);
    expect(frags[1].payload.length).toBe(V7_HEADER_SIZE + 1);
  });

  it('every fragment fits the mesh budget (V6B payload would not overflow)', () => {
    // A long sentence producing several fragments.
    const v6a = new Uint8Array(2000);
    const frags = splitV6AForBudget(v6a, MESH_CHUNK_BUDGET);
    expect(frags.length).toBeGreaterThan(1);
    for (const frag of frags) {
      expect(frag.payload.length).toBeLessThanOrEqual(MESH_CHUNK_BUDGET);
      expect(frag.payload[0]).toBe(V7_MARKER);
    }
  });

  it('budgeted fragments round-trip through the Reassembler', () => {
    const v6a = new Uint8Array(1100);
    for (let i = 0; i < v6a.length; i++) v6a[i] = i & 0xff;

    const frags = splitV6AForBudget(v6a, MESH_CHUNK_BUDGET);
    expect(frags.length).toBe(3); // 462 + 462 + 176

    const reassembler = new Reassembler();
    const from = 'peer-A';
    let completed: Uint8Array | null = null;
    for (const frag of frags) {
      const header = parseHeader(frag.payload);
      const chunk = frag.payload.slice(V7_HEADER_SIZE);
      const result = reassembler.addFragment(from, header, chunk);
      if (result.status === 'complete') completed = result.v6aPacket;
    }

    expect(completed).not.toBeNull();
    expect(completed!.length).toBe(v6a.length);
    expect(Array.from(completed!)).toEqual(Array.from(v6a));
  });

  it('out-of-order fragments still round-trip', () => {
    const v6a = new Uint8Array(1000);
    const frags = splitV6AForBudget(v6a, MESH_CHUNK_BUDGET);
    const reassembler = new Reassembler();
    const from = 'peer-B';
    let completed: Uint8Array | null = null;
    for (const frag of [...frags].reverse()) {
      const header = parseHeader(frag.payload);
      const result = reassembler.addFragment(from, header, frag.payload.slice(V7_HEADER_SIZE));
      if (result.status === 'complete') completed = result.v6aPacket;
    }
    expect(completed).not.toBeNull();
    expect(completed!.length).toBe(1000);
  });

  it('throws when the budget cannot even hold the V7 header plus one byte', () => {
    const v6a = new Uint8Array(10);
    expect(() => splitV6AForBudget(v6a, V7_HEADER_SIZE)).toThrow(V7FragmentError);
    expect(() => splitV6AForBudget(v6a, 0)).toThrow(V7FragmentError);
  });

  it('budget larger than the default chunk size is clamped to transport limits', () => {
    // A huge budget must not produce fragments larger than 499-byte V6B payloads.
    const v6a = new Uint8Array(1000);
    const frags = splitV6AForBudget(v6a, 10_000);
    for (const frag of frags) {
      expect(frag.payload.length).toBeLessThanOrEqual(499);
    }
  });

  it('oversized V6A still throws V6A_TOO_LARGE', () => {
    const v6a = new Uint8Array(MAX_V6A_LENGTH + 1);
    expect(() => splitV6AForBudget(v6a, MESH_CHUNK_BUDGET)).toThrow(V7FragmentError);
  });
});
