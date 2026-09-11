import {
  decodeChatApplicationPayload,
  encodeChatApplicationPayload,
  receiveChatApplicationPayload,
  registerChatTransport,
  resetChatMessageService,
  sendChatMessage,
} from '../ChatMessageService';
import { getChatSnapshot, resetChatMessageStore } from '../ChatMessageStore';
import {
  encodeUnrestricted,
  parseHeader,
  splitV6AForBudget,
  V6B_MAX_PAYLOAD_SIZE,
  V7_HEADER_SIZE,
} from '../../protocol';
import { restartGroupIdCounterForTests, resetGroupIdCounter } from '../../protocol/FragmentCodec';
import { createSemanticMessage } from '../../semantic';
import { HEADER_SIZE as BITCHAT_HEADER_SIZE } from '../../BITCHAT';

const LOCAL = '0x0000000000000001';
const REMOTE = '0x0000000000000002';

describe('ChatMessageService', () => {
  beforeEach(() => {
    resetChatMessageStore();
    resetChatMessageService();
    resetGroupIdCounter();
  });

  it('uses the registered BITCHAT originate function with the selected logical NodeId', async () => {
    const originate = jest.fn(async () => 1);
    registerChatTransport({
      localNodeId: LOCAL,
      originate,
      canRouteTo: destination => destination === REMOTE,
    });

    const message = await sendChatMessage(REMOTE, 'mesh hello');
    const calls = originate.mock.calls as unknown as Array<[Uint8Array, string, string, number]>;

    expect(message.status).toBe('SENT');
    expect(originate).toHaveBeenCalledTimes(1);
    expect(calls[0][2]).toBe(REMOTE);
    expect(decodeChatApplicationPayload(calls[0][0])).not.toBeNull();
    expect(getChatSnapshot().messages).toEqual([
      expect.objectContaining({
        conversationNodeId: REMOTE,
        direction: 'outgoing',
        status: 'SENT',
        text: 'mesh hello',
      }),
    ]);
  });

  it('records FAILED when the existing mesh has no route', async () => {
    registerChatTransport({
      localNodeId: LOCAL,
      originate: jest.fn(async () => 1),
      canRouteTo: () => false,
    });

    await expect(sendChatMessage(REMOTE, 'offline')).rejects.toThrow('No connected mesh route');
    expect(getChatSnapshot().messages[0]).toEqual(expect.objectContaining({
      status: 'FAILED',
      conversationNodeId: REMOTE,
    }));
  });

  it('does not claim a non-chat payload and leaves it for the voice pipeline', () => {
    expect(receiveChatApplicationPayload(new Uint8Array([0x02, 0x01]), {
      sourceNodeId: REMOTE,
    })).toBe(false);
    expect(getChatSnapshot().messages).toEqual([]);
  });

  it('renders a fragmented chat message only after V7 reassembly and deduplicates it', async () => {
    const originate = jest.fn(async () => 1);
    registerChatTransport({
      localNodeId: LOCAL,
      originate,
      canRouteTo: () => true,
    });

    await sendChatMessage(REMOTE, 'm'.repeat(700));
    const calls = originate.mock.calls as unknown as Array<[Uint8Array, string, string, number]>;
    expect(calls.length).toBeGreaterThan(1);

    const incomingBefore = () => getChatSnapshot().messages.filter(message => message.direction === 'incoming');
    for (let index = 0; index < calls.length - 1; index++) {
      expect(receiveChatApplicationPayload(calls[index][0], {
        sourceNodeId: REMOTE,
        destinationNodeId: LOCAL,
      })).toBe(true);
      expect(incomingBefore()).toHaveLength(0);
    }

    const lastPayload = calls[calls.length - 1][0];
    expect(receiveChatApplicationPayload(lastPayload, {
      sourceNodeId: REMOTE,
      destinationNodeId: LOCAL,
    })).toBe(true);
    expect(incomingBefore()).toEqual([
      expect.objectContaining({ text: 'm'.repeat(700), status: 'RECEIVED', senderNodeId: REMOTE }),
    ]);

    receiveChatApplicationPayload(lastPayload, {
      sourceNodeId: REMOTE,
      destinationNodeId: LOCAL,
    });
    expect(incomingBefore()).toHaveLength(1);
  });

  it('keeps the application discriminator outside the V6A payload', () => {
    const v6a = new Uint8Array([0x02, 0x01, 0x02]);
    const wrapped = encodeChatApplicationPayload(v6a);
    expect(Array.from(wrapped.slice(4))).toEqual(Array.from(v6a));
  });

  it('UNIT-LEVEL ONLY: renders chat only after complete reconstruction at the exact mesh boundary, one byte over it, out of order, and with a duplicate fragment', () => {
    // The typed-chat payload has four discriminator bytes inside the existing
    // BITCHAT/V6B budget. This is the same budget used by sendChatMessage.
    const chunkBudget = V6B_MAX_PAYLOAD_SIZE - BITCHAT_HEADER_SIZE - 4;
    const maxV6AWithoutFragment = chunkBudget - V7_HEADER_SIZE;

    const makeV6AAtLeast = (minimumLength: number) => {
      let textLength = 1;
      while (true) {
        const semantic = createSemanticMessage('x'.repeat(textLength));
        const v6a = encodeUnrestricted(semantic);
        if (v6a.length >= minimumLength) return { semantic, v6a };
        textLength++;
      }
    };

    const exact = makeV6AAtLeast(maxV6AWithoutFragment);
    expect(exact.v6a).toHaveLength(maxV6AWithoutFragment);
    const exactFragments = splitV6AForBudget(exact.v6a, chunkBudget);
    expect(exactFragments).toEqual([]);
    receiveChatApplicationPayload(encodeChatApplicationPayload(exact.v6a), {
      sourceNodeId: REMOTE,
      destinationNodeId: LOCAL,
    });
    expect(getChatSnapshot().messages).toHaveLength(1);

    resetChatMessageStore();
    const oversized = makeV6AAtLeast(maxV6AWithoutFragment + 1);
    expect(oversized.v6a).toHaveLength(maxV6AWithoutFragment + 1);
    const fragments = splitV6AForBudget(oversized.v6a, chunkBudget);
    expect(fragments.length).toBeGreaterThan(1);

    // Out-of-order arrival and a repeated fragment must not produce a chat
    // record until every distinct V7 fragment has reached the chat reassembler.
    const reordered = [...fragments].reverse();
    const first = encodeChatApplicationPayload(reordered[0].payload);
    expect(receiveChatApplicationPayload(first, {
      sourceNodeId: REMOTE,
      destinationNodeId: LOCAL,
    })).toBe(true);
    expect(receiveChatApplicationPayload(first, {
      sourceNodeId: REMOTE,
      destinationNodeId: LOCAL,
    })).toBe(true);
    expect(getChatSnapshot().messages).toHaveLength(0);

    for (const fragment of reordered.slice(1)) {
      const header = parseHeader(fragment.payload);
      expect(header.fragmentIndex).toBeGreaterThanOrEqual(0);
      receiveChatApplicationPayload(encodeChatApplicationPayload(fragment.payload), {
        sourceNodeId: REMOTE,
        destinationNodeId: LOCAL,
      });
    }

    expect(getChatSnapshot().messages).toEqual([
      expect.objectContaining({
        senderNodeId: REMOTE,
        recipientNodeId: LOCAL,
        text: oversized.semantic.text,
        status: 'RECEIVED',
      }),
    ]);
  });

  it('UNIT-LEVEL ONLY: incomplete chat fragments do not create a bubble', () => {
    const semantic = createSemanticMessage('i'.repeat(900));
    const chunkBudget = V6B_MAX_PAYLOAD_SIZE - BITCHAT_HEADER_SIZE - 4;
    const fragments = splitV6AForBudget(encodeUnrestricted(semantic), chunkBudget);
    expect(fragments.length).toBeGreaterThan(1);

    receiveChatApplicationPayload(encodeChatApplicationPayload(fragments[0].payload), {
      sourceNodeId: REMOTE,
      destinationNodeId: LOCAL,
    });
    expect(getChatSnapshot().messages).toEqual([]);
  });

  it('keeps an incomplete pre-restart group isolated from a same-shaped post-restart chat message', () => {
    const chunkBudget = V6B_MAX_PAYLOAD_SIZE - BITCHAT_HEADER_SIZE - 4;
    const oldSemantic = createSemanticMessage('a'.repeat(700));
    const oldFragments = splitV6AForBudget(encodeUnrestricted(oldSemantic), chunkBudget);
    expect(oldFragments).toHaveLength(2);

    // The original sender process leaves only fragment zero in flight.
    receiveChatApplicationPayload(encodeChatApplicationPayload(oldFragments[0].payload), {
      sourceNodeId: REMOTE,
      destinationNodeId: LOCAL,
    });

    // A restart must choose a new process seed. The new message intentionally
    // has the same V6A length and fragment count, which was sufficient to mix
    // content when both group IDs restarted at zero.
    restartGroupIdCounterForTests(0x6a09e667);
    const newSemantic = createSemanticMessage('b'.repeat(700));
    const newFragments = splitV6AForBudget(encodeUnrestricted(newSemantic), chunkBudget);
    expect(newFragments).toHaveLength(2);
    expect(newFragments[0].header).toEqual(expect.objectContaining({
      totalFragments: oldFragments[0].header.totalFragments,
      v6aLength: oldFragments[0].header.v6aLength,
    }));
    expect(newFragments[0].header.groupId).not.toBe(oldFragments[0].header.groupId);

    // Out-of-order new traffic interleaves with the old partial group. It
    // must never complete a hybrid old-header/new-body semantic message.
    receiveChatApplicationPayload(encodeChatApplicationPayload(newFragments[1].payload), {
      sourceNodeId: REMOTE,
      destinationNodeId: LOCAL,
    });
    expect(getChatSnapshot().messages).toEqual([]);
    receiveChatApplicationPayload(encodeChatApplicationPayload(newFragments[0].payload), {
      sourceNodeId: REMOTE,
      destinationNodeId: LOCAL,
    });

    expect(getChatSnapshot().messages).toEqual([
      expect.objectContaining({
        text: newSemantic.text,
        senderNodeId: REMOTE,
        status: 'RECEIVED',
      }),
    ]);
  });
});
