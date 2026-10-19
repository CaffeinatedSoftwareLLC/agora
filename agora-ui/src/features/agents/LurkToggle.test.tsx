import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SessionSheet } from './SessionSheet';
import { parseAgentCommand } from '../messages/AgentCommands';
import type { AgentSession } from './agentSessions';
import { useMessageStore } from '../../stores/messageStore';
import { useThreadStore } from '../../stores/threadStore';

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() }); });
const post = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async orig => {
  const actual = await orig<typeof import('../../lib/api')>();
  return { ...actual, api: { ...actual.api, post: (...args: unknown[]) => post(...args) } };
});
afterEach(() => { cleanup(); post.mockReset(); });
const session: AgentSession = { id: 'S1', profile: 'codex', botUsername: 'codex', state: 'live', endReason: null,
  wakesUsed: 1, tokensUsed: 10, lastActiveAt: '', lurkMode: null };

it('parses the default dial, each explicit dial and off; rejects invalid dials', () => {
  expect(parseAgentCommand('/lurk Codex')).toEqual({ command: 'lurk', profile: 'codex', lurkMode: 'balanced' });
  for (const dial of ['quiet', 'balanced', 'vocal']) expect(parseAgentCommand(`/lurk codex ${dial}`)).toEqual({ command: 'lurk', profile: 'codex', lurkMode: dial });
  expect(parseAgentCommand('/lurk codex off')).toEqual({ command: 'lurk', profile: 'codex', lurkMode: null });
  expect(parseAgentCommand('/lurk codex loud')).toBe('usage');
  expect(parseAgentCommand('/lurk')).toBe('usage');
});

it('enables lurk, changes the dial and turns it off through the session sheet', async () => {
  post.mockResolvedValue({ action: 'lurk_updated' });
  const onChanged = vi.fn();
  const props = { open: true, onClose: vi.fn(), channelId: 'C1', mode: { kind: 'profile' as const, profile: 'codex' }, profiles: [], onChanged };
  const view = render(<SessionSheet {...props} sessions={[session]} />);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Lurk mode' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  expect(post).toHaveBeenLastCalledWith('/channels/C1/agent-commands', { command: 'lurk', profile: 'codex', lurkMode: 'balanced' });
  view.rerender(<SessionSheet {...props} sessions={[{ ...session, lurkMode: 'balanced' }]} />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Lurk dial' }), { target: { value: 'quiet' } });
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
  expect(post).toHaveBeenLastCalledWith('/channels/C1/agent-commands', { command: 'lurk', profile: 'codex', lurkMode: 'quiet' });
  view.rerender(<SessionSheet {...props} sessions={[{ ...session, lurkMode: 'quiet' }]} />);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Lurk mode' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(3));
  expect(post).toHaveBeenLastCalledWith('/channels/C1/agent-commands', { command: 'lurk', profile: 'codex', lurkMode: null });
});

it('shows authority errors and keeps the switch off', async () => {
  const { ApiError } = await import('../../lib/api');
  post.mockRejectedValue(new ApiError(403, 'cannot_direct'));
  render(<SessionSheet open onClose={vi.fn()} channelId="C1" mode={{ kind: 'profile', profile: 'codex' }} sessions={[session]} profiles={[]} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Lurk mode' }));
  expect(await screen.findByText(/Only the owner and directors/)).toBeTruthy();
  expect((screen.getByRole('checkbox', { name: 'Lurk mode' }) as HTMLInputElement).checked).toBe(false);
});

it('applies late attachment events to channel messages and thread replies without losing the text', () => {
  const message = { id: 'M1', content: 'See `shot.png`', authorId: 'bot', authorUsername: 'codex', channelId: 'C1', createdAt: '' };
  useMessageStore.setState({ byChannel: new Map([['C1', [message]]]) });
  useThreadStore.setState({ repliesByThread: new Map([['T1', [message]]]) });
  const attachments = [{ id: 'F1', name: 'shot.png', mime: 'image/png', size: 50, width: 1, height: 1, url: '/files/F1' }];
  const event = { id: 'M1', channelId: 'C1', content: message.content, editedAt: '', attachments };
  useMessageStore.getState().updateMessage(event);
  useThreadStore.getState().updateReply({ ...event, threadId: 'T1' });
  expect(useMessageStore.getState().byChannel.get('C1')?.[0]).toMatchObject({ content: message.content, attachments });
  expect(useThreadStore.getState().repliesByThread.get('T1')?.[0]).toMatchObject({ content: message.content, attachments });
});
