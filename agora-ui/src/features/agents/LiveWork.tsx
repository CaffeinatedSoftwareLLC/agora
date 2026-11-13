import { useEffect, useRef } from 'react';
import type { RunStreamView, StreamStep } from './runStream';

/** The text a block shows: its end, so a long message does not push the page around. */
const SHOWN = 2400;

function StepMark({ state }: { state: StreamStep['state'] }) {
  if (state === 'running') return <span aria-hidden="true" className="inline-block h-3 w-3 shrink-0 rounded-full border-2 border-primary border-t-transparent motion-safe:animate-spin" />;
  return <span aria-hidden="true" className={`inline-block w-3 shrink-0 text-center text-xs leading-none ${state === 'ok' ? 'text-online' : 'text-danger'}`}>{state === 'ok' ? '✓' : '✗'}</span>;
}

/**
 * A running agent's live output (docs/live-output.md): its text as it is written, and a compact,
 * collapsible list of its steps with a spinner on the one in progress. Shown only while the run
 * goes; the agent's real post is in the message list when it ends. Reasoning is never sent.
 */
export function LiveWork({ stream, name }: { stream: RunStreamView; name: string }) {
  const box = useRef<HTMLParagraphElement>(null);
  const stick = useRef(true);
  const shown = stream.text.length > SHOWN ? stream.text.slice(-SHOWN) : stream.text;
  const cut = stream.textTruncated || stream.text.length > SHOWN;
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown]);
  const steps = stream.steps;
  const current = [...steps].reverse().find(s => s.state === 'running') ?? steps[steps.length - 1];
  const running = steps.some(s => s.state === 'running');
  if (!shown && steps.length === 0) return null;
  return (
    <section aria-label={`${name} live output`} className="mt-1 rounded-lg border border-border border-l-2 border-l-primary/50 bg-surface/40 px-3 py-2 text-sm text-text" data-testid="live-work">
      {shown && <p ref={box} data-testid="live-text" className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words"
        onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>
        {cut && '…'}{shown}
      </p>}
      {steps.length > 0 && <details className={shown ? 'mt-1' : ''} data-testid="live-steps">
        <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-text-muted">
          {current && <StepMark state={running ? 'running' : current.state} />}
          <span className="min-w-0 flex-1 truncate">{current?.label}</span>
          <span className="shrink-0">{steps.length} {steps.length === 1 ? 'step' : 'steps'}</span>
        </summary>
        <ul className="max-h-40 space-y-1 overflow-y-auto pb-1 text-xs text-text-muted">
          {steps.map(s => <li key={s.step} className="flex items-center gap-2" data-state={s.state}>
            <StepMark state={s.state} /><span className="min-w-0 break-words">{s.label}</span>
          </li>)}
        </ul>
      </details>}
    </section>
  );
}
