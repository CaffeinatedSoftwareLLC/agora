import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunActivity } from './RunActivity';
import { elapsedTime } from './agentSessions';
import { SessionBudget } from './SessionBudget';
import { useAuthStore } from '../../stores/authStore';
import { useChannelStore } from '../../stores/channelStore';
import { useServerStore } from '../../stores/serverStore';
import type { AgentSession } from './agentSessions';

const storage = vi.hoisted(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  return values;
});
const socket = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn() }));
const post = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useSocket', () => ({ useSocket: () => socket }));
vi.mock('../../lib/api', async orig => ({ ...await orig<typeof import('../../lib/api')>(), api: { post: (...args: unknown[]) => post(...args) } }));
const session = (over: Partial<AgentSession> = {}): AgentSession => ({ id: 'session', profile: 'claude', botUsername: 'claude', state: 'live', endReason: null, wakesUsed: 2, tokensUsed: 10, tokenBudget: 100, lastActiveAt: '', run: { id: 'run', status: 'claimed', startedAt: new Date(Date.now() - 65_000).toISOString(), finishedAt: null, error: null, changedPaths: [] }, ...over });
beforeEach(() => { socket.on.mockReset(); socket.off.mockReset(); post.mockReset(); storage.clear(); useAuthStore.setState({ user: { id: 'me', username: 'me' } }); });
afterEach(() => { vi.useRealTimers(); });
describe('run activity', () => {
  it('shows working and elapsed time, then socket-driven blocked state and changed files', async () => {
    const s = session(); post.mockResolvedValue({ sessions: [s] });
    const { unmount } = render(<RunActivity channelId="channel" />);
    expect(await screen.findByText(/claude is working/)).toHaveTextContent('1m 5s');
    const handler = socket.on.mock.calls.find(c => c[0] === 'AgentSessionUpdate')![1];
    post.mockResolvedValue({ sessions: [{ ...s, run: { ...s.run, status: 'succeeded', error: 'nothing_posted', changedPaths: ['src/a.ts'] } }] });
    act(() => handler({ channelId: 'other' })); expect(post).toHaveBeenCalledTimes(1);
    act(() => handler({ channelId: 'channel' }));
    fireEvent.click(await screen.findByRole('button', { name: /^1 agent update/ }));
    expect(await screen.findByText(/possibly blocked/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('1 changed file'));
    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
    unmount(); expect(socket.off).toHaveBeenCalledWith('AgentSessionUpdate', handler);
  });
  it('shows an ACP agent\'s live progress for the current run only', async () => {
    const s = session(); post.mockResolvedValue({ sessions: [s] });
    render(<RunActivity channelId="channel" />);
    await screen.findByText(/claude is working/);
    const handler = socket.on.mock.calls.find(c => c[0] === 'AgentRunProgress')![1];
    act(() => handler({ channelId: 'channel', sessionId: 'session', runId: 'old-run', step: 'stale', toolCalls: 1, planDone: null, planTotal: null }));
    expect(screen.queryByText(/stale/)).toBeNull();
    act(() => handler({ channelId: 'other', sessionId: 'session', runId: 'run', step: 'elsewhere', toolCalls: 1, planDone: null, planTotal: null }));
    expect(screen.queryByText(/elsewhere/)).toBeNull();
    act(() => handler({ channelId: 'channel', sessionId: 'session', runId: 'run', step: 'Edit src/a.ts', toolCalls: 3, planDone: 1, planTotal: 2 }));
    expect(screen.getByLabelText('claude progress')).toHaveTextContent('Edit src/a.ts · 3 tool calls · plan 1/2');
  });
  it('shows a failed run and a budget pause', async () => {
    const s = session(); post.mockResolvedValue({ sessions: [{ ...s, run: { ...s.run, status: 'failed', error: 'cli_failed' } }, session({ id: 'paused', profile: 'codex', state: 'shelved', endReason: 'budget' })] });
    render(<RunActivity channelId="channel" />);
    fireEvent.click(await screen.findByRole('button', { name: /^2 agent updates/ }));
    expect(await screen.findByText(/run failed: cli_failed/)).toBeInTheDocument();
    expect(screen.getByText(/codex paused/)).toBeInTheDocument();
  });
  it('folds the whole historical section, keeps working visible, and remembers its state per user', async () => {
    const s = session();
    const done = session({ id: 'done', profile: 'codex', botUsername: 'codex', run: { ...s.run!, status: 'succeeded', changedPaths: ['src/a.ts'] } });
    const paused = session({ id: 'paused', profile: 'claude', state: 'shelved', endReason: 'budget' });
    post.mockResolvedValue({ sessions: [done, paused, s] });
    const first = render(<RunActivity channelId="channel" />);
    const toggle = await screen.findByRole('button', { name: '2 agent updates (codex, claude) · 2 notices' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText(/claude is working/)).toBeTruthy();
    expect(screen.queryByText('1 changed file')).toBeNull();
    expect(screen.queryByText(/codex finished/)).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText(/codex finished/)).toBeTruthy();
    fireEvent.click(screen.getByText('1 changed file'));
    expect(screen.getByText('src/a.ts')).toBeTruthy();
    first.unmount();
    const second = render(<RunActivity channelId="channel" />);
    expect((await screen.findByRole('button', { name: /^2 agent updates/ })).getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse 2 agent updates' }));
    expect(screen.getByRole('button', { name: /^2 agent updates/ }).getAttribute('aria-expanded')).toBe('false');
    second.unmount();
    useAuthStore.setState({ user: { id: 'other', username: 'other' } });
    render(<RunActivity channelId="channel" />);
    expect((await screen.findByRole('button', { name: /^2 agent updates/ })).getAttribute('aria-expanded')).toBe('false');
  });
  it('formats elapsed time without negative seconds', () => {
    expect(elapsedTime('2026-01-01T00:00:00Z', Date.parse('2026-01-01T00:02:03Z'))).toBe('2m 3s');
    expect(elapsedTime('2026-01-01T00:00:00Z', 0)).toBe('0s');
  });
  it('lets the owner save a session-specific budget', async () => {
    useAuthStore.setState({ user: { id: 'owner' } as never });
    useChannelStore.setState({ channels: new Map([['channel', { id: 'channel', name: 'general', channelType: 0, serverId: 'server' }]]) });
    useServerStore.setState({ servers: new Map([['server', { id: 'server', name: 'server', ownerId: 'owner' }]]) });
    post.mockResolvedValue({ action: 'budget_updated' }); const onChanged = vi.fn();
    render(<SessionBudget session={session()} channelId="channel" onChanged={onChanged} />);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '200' } });
    fireEvent.click(screen.getByText('Save budget'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith('/channels/channel/agent-commands', { command: 'budget', sessionId: 'session', tokenBudget: 200 });
  });
});
