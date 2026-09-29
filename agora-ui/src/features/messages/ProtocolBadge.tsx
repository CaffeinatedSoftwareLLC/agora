import type { ProtocolInfo } from '../../lib/contracts/ws-events';

type Tone = 'neutral' | 'primary' | 'accent' | 'good' | 'warn' | 'danger';

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'bg-surface-hover text-text-muted',
  primary: 'bg-primary/20 text-primary',
  accent: 'bg-accent/20 text-accent',
  good: 'bg-online/20 text-online',
  warn: 'bg-warn/20 text-warn',
  danger: 'bg-danger/20 text-danger',
};

function toneFor(protocol: ProtocolInfo): Tone {
  switch (protocol.state) {
    case 'START':
    case 'ACK':
      return 'accent';
    case 'TURN':
      return 'primary';
    case 'CHECKPOINT':
      return 'neutral';
    case 'DECIDE':
      return protocol.decision === 'BLOCK' ? 'danger' : 'good';
    case 'DONE':
      return 'good';
    case 'BLOCK':
      return 'danger';
    case 'CANCEL':
      return 'warn';
  }
}

function labelFor(protocol: ProtocolInfo): string {
  if (protocol.state === 'DECIDE' && protocol.decision) return `DECIDE · ${protocol.decision}`;
  return protocol.state;
}

/** Compact pill for an agora-collab protocol message: state, handoff target, mode on hover. */
export function ProtocolBadge({ protocol }: { protocol: ProtocolInfo }) {
  const title = [
    `agora-collab · ${protocol.mode}`,
    protocol.participants?.length ? `participants: ${protocol.participants.join(', ')}` : null,
  ].filter(Boolean).join('\n');

  return (
    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[10px] font-semibold leading-none" title={title}>
      <span className={`px-1.5 py-0.5 rounded ${TONE_CLASS[toneFor(protocol)]}`}>{labelFor(protocol)}</span>
      {protocol.yieldTo && (
        <span className="text-text-dim font-normal">→ {protocol.yieldTo}</span>
      )}
    </span>
  );
}
