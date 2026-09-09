/**
 * V9B MeshRouter — Tests
 */

import { MeshRouter, PeerQuery } from '../mesh/MeshRouter';
import type { PeerInfo } from '../peer/PeerTypes';

function makePeer(id: string, state: PeerInfo['state'] = 'CONNECTED'): PeerInfo {
  return { peerId: id, lastSeen: Date.now(), state };
}

function makePeerQuery(peers: PeerInfo[]): PeerQuery {
  return { getPeers: () => peers };
}

describe('MeshRouter', () => {
  it('returns only CONNECTED peers', () => {
    const peers = [
      makePeer('0x0000000000000001', 'CONNECTED'),
      makePeer('0x0000000000000002', 'DISCOVERED'),
      makePeer('0x0000000000000003', 'STALE'),
    ];
    const router = new MeshRouter('0x0000000000000000', makePeerQuery(peers));

    const result = router.getRelayPeers();
    expect(result).toEqual(['0x0000000000000001']);
  });

  it('excludes incoming peer', () => {
    const peers = [
      makePeer('0x0000000000000001', 'CONNECTED'),
      makePeer('0x0000000000000002', 'CONNECTED'),
    ];
    const router = new MeshRouter('0x0000000000000000', makePeerQuery(peers));

    const result = router.getRelayPeers('0x0000000000000001');
    expect(result).toEqual(['0x0000000000000002']);
  });

  it('returns empty list if no connected peers', () => {
    const peers = [
      makePeer('0x0000000000000001', 'DISCOVERED'),
      makePeer('0x0000000000000002', 'STALE'),
    ];
    const router = new MeshRouter('0x0000000000000000', makePeerQuery(peers));

    expect(router.getRelayPeers()).toEqual([]);
  });

  it('deterministic ordering (sorted by hex)', () => {
    const peers = [
      makePeer('0x0000000000000003', 'CONNECTED'),
      makePeer('0x0000000000000001', 'CONNECTED'),
      makePeer('0x0000000000000002', 'CONNECTED'),
    ];
    const router = new MeshRouter('0x0000000000000000', makePeerQuery(peers));

    const result = router.getRelayPeers();
    expect(result).toEqual([
      '0x0000000000000001',
      '0x0000000000000002',
      '0x0000000000000003',
    ]);
  });

  it('NodeId normalization works', () => {
    const peers = [makePeer('0x0000000000000001', 'CONNECTED')];
    const router = new MeshRouter('0x0', makePeerQuery(peers));

    // Pass unnormalized incomingPeerId
    const result = router.getRelayPeers('0x1');
    expect(result).toEqual([]); // 0x1 normalizes to 0x0000000000000001, which is excluded
  });

  it('local node is not returned', () => {
    const peers = [makePeer('0x0000000000000000', 'CONNECTED')];
    const router = new MeshRouter('0x0000000000000000', makePeerQuery(peers));

    const result = router.getRelayPeers();
    expect(result).toEqual([]);
  });

  it('disconnected/stale peers not returned', () => {
    const peers = [
      makePeer('0x0000000000000001', 'DISCOVERED'),
      makePeer('0x0000000000000002', 'STALE'),
      makePeer('0x0000000000000003', 'CONNECTED'),
    ];
    const router = new MeshRouter('0x0000000000000000', makePeerQuery(peers));

    const result = router.getRelayPeers();
    expect(result).toEqual(['0x0000000000000003']);
  });
});
