/**
 * Development-only correlation for one PTT voice turn.
 *
 * The packet ID is deliberately the same UInt64 value eventually placed in
 * the BITCHAT envelope.  It lets the STT, JS routing, native send, and
 * receiver-side BITCHAT/TTS logs be joined without adding data to the wire.
 */
import { generateMessageId } from '../semantic';
import { hashMessageId } from '../protocol';

export interface VoiceMvpTrace {
  /** Source semantic ID, fixed before STT starts for this PTT turn. */
  semanticMessageId: string;
  /** Wire-visible BITCHAT packet ID used as `msgId` in diagnostics. */
  packetId: string;
}

let activeTrace: VoiceMvpTrace | null = null;

export function beginVoiceMvpTrace(): VoiceMvpTrace {
  const semanticMessageId = generateMessageId();
  const packetId = `0x${hashMessageId(semanticMessageId).toString(16).padStart(16, '0')}`;
  activeTrace = { semanticMessageId, packetId };
  return activeTrace;
}

/** Returns the active trace without consuming it (for STT_START logging). */
export function getActiveVoiceMvpTrace(): VoiceMvpTrace | null {
  return activeTrace;
}

/** Returns the current trace and clears it once STT has produced its final result. */
export function takeVoiceMvpTrace(): VoiceMvpTrace | null {
  const trace = activeTrace;
  activeTrace = null;
  return trace;
}

/** Clear an aborted PTT turn so it cannot be attributed to a later utterance. */
export function clearVoiceMvpTrace(): void {
  activeTrace = null;
}
