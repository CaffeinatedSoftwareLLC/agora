import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SessionSheet } from './SessionSheet';
import type { AgentSession } from './agentSessions';
import { ApiError } from '../../lib/api';

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() }); });
const post = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async orig => {
  const actual = await orig<typeof import('../../lib/api')>();
  return { ...actual, api: { ...actual.api, post: (...args: unknown[]) => post(...args) } };
});
afterEach(() => { cleanup(); post.mockReset(); });

const commands = [
  { name: 'compact', summary: 'Compact the conversation', ownerOnly: false },
  { name: 'context', summary: 'Show how full the context is', ownerOnly: false },
  { name: 'clear', summary: 'Start a fresh conversation', ownerOnly: true },
  { name: 'stop', summary: 'Stop the current run', ownerOnly: false },
];
const session: AgentSession = { id: 'S1', profile: 'claude', botUsername: 'claude', state: 'live', endReason: null,
  wakesUsed: 1, tokensUsed: 10, lastActiveAt: '', lurkMode: null, adapter: 'claude', commands, pendingCommand: null };
const props = { open: true, onClose: vi.fn(), channelId: 'C1', mode: { kind: 'profile' as const, profile: 'claude' }, profiles: [], onChanged: vi.fn() };

it('lists the commands this agent\'s CLI supports and sends the one pressed as a control command', async () => {
  post.mockResolvedValue({ action: 'control', outcome: 'queued' });
  render(<SessionSheet {...props} sessions={[session]} />);
  const group = screen.getByRole('group', { name: 'Commands' });
  expect(within(group).getAllByRole('button').map(b => b.textContent)).toEqual(['/compact', '/context', '/clear', '/stop']);
  expect(within(group).getByRole('button', { name: '/clear' }).getAttribute('title')).toBe('Start a fresh conversation (owner only)');
  expect(within(group).getByText('@claude /compact')).toBeTruthy();
  fireEvent.click(within(group).getByRole('button', { name: '/compact' }));
  await waitFor(() => expect(post).toHaveBeenCalledWith('/channels/C1/agent-commands', { command: 'control', profile: 'claude', control: 'compact' }));
  expect(await screen.findByText('Command sent. The result is posted in the channel.')).toBeTruthy();
});

it('shows a command waiting for its turn and only leaves Stop available', () => {
  render(<SessionSheet {...props} sessions={[{ ...session, pendingCommand: { command: 'compact', status: 'queued' } }]} />);
  const group = screen.getByRole('group', { name: 'Commands' });
  expect(within(group).getByText('/compact is waiting for its turn.')).toBeTruthy();
  expect((within(group).getByRole('button', { name: '/context' }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(group).getByRole('button', { name: '/stop' }) as HTMLButtonElement).disabled).toBe(false);
});

it('says where the reason is when the server refuses a command', async () => {
  post.mockRejectedValue(new ApiError(409, 'command_refused'));
  render(<SessionSheet {...props} sessions={[session]} />);
  fireEvent.click(within(screen.getByRole('group', { name: 'Commands' })).getByRole('button', { name: '/clear' }));
  expect(await screen.findByText('Not sent. The reason is posted in the channel.')).toBeTruthy();
});

it('offers no menu for an agent whose CLI has no commands, and tells a terminal session to type them there', () => {
  const { rerender } = render(<SessionSheet {...props} sessions={[{ ...session, commands: [] }]} />);
  expect(screen.queryByRole('group', { name: 'Commands' })).toBeNull();
  const terminal: AgentSession = { ...session, id: 'T1', kind: 'terminal', botId: 'B1', commands: [] };
  rerender(<SessionSheet {...props} mode={{ kind: 'terminal', botId: 'B1' }} sessions={[terminal]} />);
  expect(screen.queryByRole('group', { name: 'Commands' })).toBeNull();
  expect(screen.getByTestId('terminal-commands').textContent).toMatch(/type them in that terminal/);
});
