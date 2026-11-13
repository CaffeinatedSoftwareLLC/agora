import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RunActivity } from './RunActivity';
import { LiveWork } from './LiveWork';
import { applyEvents, emptyView, useRunStreams } from './runStream';
import { useAuthStore } from '../../stores/authStore';
import type { AgentSession } from './agentSessions';
import type { RunStreamEvent } from '../../lib/contracts/ws-events';

/** Live output (docs/live-output.md): the block grows, lists steps, goes with the run, and a late joiner sees the tail. */
const socket = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn() }));
const api = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));
vi.mock('../../hooks/useSocket', () => ({ useSocket: () => socket }));
vi.mock('../../lib/api', async orig => ({ ...await orig<typeof import('../../lib/api')>(), api }));
const handler = (name: string) => socket.on.mock.calls.filter(c => c[0] === name).at(-1)![1];
const batch = (seq: number, events: unknown[], over: Record<string, unknown> = {}) =>
  ({ channelId: 'channel', sessionId: 'session', runId: 'run', threadId: null, profile: 'claude', seq, events, ...over });
const session = (): AgentSession => ({ id: 'session', profile: 'claude', botUsername: 'claude', state: 'live', endReason: null, wakesUsed: 1, tokensUsed: 1, tokenBudget: 100, lastActiveAt: '',
  run: { id: 'run', status: 'claimed', startedAt: new Date().toISOString(), finishedAt: null, error: null, changedPaths: [] } } as AgentSession);
const text = (delta: string, replace = false): RunStreamEvent => ({ type: 'text', message: 'm', delta, ...(replace ? { replace: true } : {}) });
const step = (id: string, state: 'start' | 'ok' | 'failed', label?: string): RunStreamEvent => ({ type: 'step', step: id, state, ...(label ? { tool: 'Read', label } : {}) });

beforeEach(() => {
  socket.on.mockReset(); socket.off.mockReset(); api.post.mockReset(); api.get.mockReset();
  api.post.mockResolvedValue({ sessions: [session()] });
  api.get.mockResolvedValue({ streams: [] });
  useAuthStore.setState({ user: { id: 'me', username: 'me' } });
});

describe('applying events', () => {
  it('adds text, replaces it when told to, and tracks a step from start to end', () => {
    let v = emptyView({ runId: 'r', sessionId: 's' });
    v = applyEvents(v, [text('Hel'), text('lo'), step('a', 'start', 'Read a.ts')]);
    expect(v.text).toBe('Hello'); expect(v.steps).toEqual([{ step: 'a', tool: 'Read', label: 'Read a.ts', state: 'running' }]);
    v = applyEvents(v, [step('a', 'ok'), step('a', 'start', 'again'), text('Fresh', true)]);
    expect(v.text).toBe('Fresh'); expect(v.steps).toHaveLength(1); expect(v.steps[0].state).toBe('ok');
  });
  it('keeps the end of a very long text and at most 50 steps', () => {
    let v = emptyView({ runId: 'r', sessionId: 's' });
    v = applyEvents(v, [text('x'.repeat(20000)), ...Array.from({ length: 60 }, (_, i) => step(`s${i}`, 'start', `step ${i}`))]);
    expect(v.text).toHaveLength(16000); expect(v.textTruncated).toBe(true); expect(v.steps).toHaveLength(50); expect(v.steps[0].label).toBe('step 10');
  });
});

describe('the live block', () => {
  it('shows the text growing and the steps with a spinner on the one in progress', async () => {
    render(<RunActivity channelId="channel" />);
    await screen.findByText(/claude is working/);
    expect(screen.queryByTestId('live-work')).toBeNull();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/channels/channel/agent-run-streams'));
    act(() => handler('AgentRunStream')(batch(1, [text('Looking at the ', true), step('t1', 'start', 'Read src/app.ts')])));
    expect(screen.getByTestId('live-text')).toHaveTextContent('Looking at the');
    act(() => handler('AgentRunStream')(batch(2, [text('build output.')])));
    expect(screen.getByTestId('live-text')).toHaveTextContent('Looking at the build output.');
    const steps = screen.getByTestId('live-steps');
    expect(steps).toHaveTextContent('Read src/app.ts'); expect(steps).toHaveTextContent('1 step');
    // collapsed to the current step; the full list opens on demand
    expect(steps.hasAttribute('open')).toBe(false);
    act(() => handler('AgentRunStream')(batch(3, [step('t1', 'ok'), step('t2', 'start', 'Ran npm test')])));
    fireEvent.click(steps.querySelector('summary')!);
    const items = steps.querySelectorAll('li');
    expect([...items].map(li => li.getAttribute('data-state'))).toEqual(['ok', 'running']);
    expect(steps.querySelector('summary')).toHaveTextContent('Ran npm test');
    expect(steps.querySelector('summary')).toHaveTextContent('2 steps');
  });
  it('ignores batches for other channels and an old batch number, and goes away when the run ends', async () => {
    render(<RunActivity channelId="channel" />);
    await screen.findByText(/claude is working/);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    act(() => handler('AgentRunStream')(batch(1, [text('first', true)], { channelId: 'other' })));
    expect(screen.queryByTestId('live-work')).toBeNull();
    act(() => handler('AgentRunStream')(batch(2, [text('second', true)])));
    act(() => handler('AgentRunStream')(batch(2, [text(' repeated')])));
    act(() => handler('AgentRunStream')(batch(1, [text(' stale')])));
    expect(screen.getByTestId('live-text')).toHaveTextContent(/^second$/);
    act(() => handler('AgentRunStreamEnd')({ channelId: 'channel', sessionId: 'session', runId: 'run' }));
    expect(screen.queryByTestId('live-work')).toBeNull();
    // a straggler after the end does not bring it back
    act(() => handler('AgentRunStream')(batch(3, [text('late')])));
    expect(screen.queryByTestId('live-work')).toBeNull();
  });
  it('is not shown for a run that is not the session\'s current one, or once the run is no longer working', async () => {
    api.post.mockResolvedValue({ sessions: [{ ...session(), run: { ...session().run, status: 'succeeded' } }] });
    render(<RunActivity channelId="channel" />);
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    act(() => handler('AgentRunStream')(batch(1, [text('x', true)])));
    expect(screen.queryByTestId('live-work')).toBeNull();
  });
  it('a person who opens the channel mid-run sees the tail, then the batches that follow; batches the tail covers are skipped', async () => {
    let release!: (v: unknown) => void;
    api.get.mockReturnValue(new Promise(r => { release = r; }));
    render(<RunActivity channelId="channel" />);
    await screen.findByText(/claude is working/);
    // batches 4 and 5 arrive while the tail is still loading
    act(() => handler('AgentRunStream')(batch(4, [text(' four')])));
    act(() => handler('AgentRunStream')(batch(5, [text(' five')])));
    expect(screen.queryByTestId('live-work')).toBeNull();
    await act(async () => release({ streams: [{ runId: 'run', sessionId: 'session', threadId: null, profile: 'claude', seq: 4, text: 'Tail so far four', textTruncated: false,
      steps: [{ step: 'a', tool: 'Read', label: 'Read a.ts', state: 'ok' }] }] }));
    expect(screen.getByTestId('live-text')).toHaveTextContent('Tail so far four five');
    expect(screen.getByTestId('live-steps')).toHaveTextContent('Read a.ts');
  });
  it('shows no block when the agent is not streaming (nothing sent), and the failed tail request does not break the channel', async () => {
    api.get.mockRejectedValue(new Error('offline'));
    render(<RunActivity channelId="channel" />);
    expect(await screen.findByText(/claude is working/)).toBeInTheDocument();
    expect(screen.queryByTestId('live-work')).toBeNull();
  });
  it('unsubscribes when it unmounts', async () => {
    const { unmount } = render(<RunActivity channelId="channel" />);
    await screen.findByText(/claude is working/);
    const h = handler('AgentRunStream'); unmount();
    expect(socket.off).toHaveBeenCalledWith('AgentRunStream', h);
  });
});

describe('LiveWork on its own', () => {
  it('shows only the end of a long text, says it is cut, and has no step list without steps', () => {
    const v = { ...emptyView({ runId: 'r', sessionId: 's' }), text: 'a'.repeat(3000) + 'END' };
    render(<LiveWork stream={v} name="claude" />);
    const shown = screen.getByTestId('live-text').textContent!;
    expect(shown.startsWith('…')).toBe(true); expect(shown.endsWith('END')).toBe(true); expect(shown.length).toBeLessThan(2500);
    expect(screen.queryByTestId('live-steps')).toBeNull();
    expect(screen.getByRole('region', { name: 'claude live output' })).toBeInTheDocument();
  });
  it('renders nothing for an empty stream', () => {
    const { container } = render(<LiveWork stream={emptyView({ runId: 'r', sessionId: 's' })} name="claude" />);
    expect(container).toBeEmptyDOMElement();
  });
  it('is usable at phone width: no fixed width, steps wrap, touch-sized summary', () => {
    const v = applyEvents(emptyView({ runId: 'r', sessionId: 's' }), [step('a', 'start', 'Ran a very long command line that wraps')]);
    render(<LiveWork stream={v} name="claude" />);
    expect(screen.getByTestId('live-work').className).not.toMatch(/\bw-\[|min-w-\[/);
    expect(screen.getByTestId('live-steps').querySelector('summary')!.className).toContain('min-h-11');
  });
});

function Probe({ enabled }: { enabled: boolean }) {
  const views = useRunStreams('channel', enabled);
  return <p data-testid="count">{Object.keys(views).length}</p>;
}
describe('useRunStreams', () => {
  it('does nothing while disabled (a closed sheet)', () => {
    render(<Probe enabled={false} />);
    expect(api.get).not.toHaveBeenCalled(); expect(socket.on).not.toHaveBeenCalled();
  });
  it('loads the tail again after the socket reconnects', async () => {
    render(<Probe enabled />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    api.get.mockResolvedValue({ streams: [{ runId: 'r2', sessionId: 's', threadId: null, profile: 'x', seq: 3, text: 'back', textTruncated: false, steps: [] }] });
    act(() => handler('connect')());
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));
    expect(api.get).toHaveBeenCalledTimes(2);
  });
});
