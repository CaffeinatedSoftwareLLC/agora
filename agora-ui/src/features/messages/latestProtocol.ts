import type { ProtocolInfo } from '../../lib/contracts/ws-events';

/** Latest protocol state across a thread (parent + replies), for the session chip. */
export function latestProtocol(messages: { protocol?: ProtocolInfo; deletedAt?: string }[]): ProtocolInfo | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.protocol && !m.deletedAt) return m.protocol;
  }
  return undefined;
}
