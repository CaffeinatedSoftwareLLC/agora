import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApiError, botApi, serverApi } from '../../lib/api';
import type { ServerAccess } from '../../lib/contracts/server';
import { useChannelStore } from '../../stores/channelStore';
import { useAuthStore } from '../../stores/authStore';
import { useMessageStore } from '../../stores/messageStore';
import { useThreadStore } from '../../stores/threadStore';
import type { Message } from '../../stores/messageStore';
import { clearCanManageBotsCache } from '../../hooks/useCanManageBots';
import { LoopGuardNotice } from './LoopGuardNotice';
import { loopGuardScope, loopGuardSummary } from './loopGuard';
import { LoopGuardBadge } from '../shell/LoopGuardBadge';

const MANAGE_BOTS = (1n << 27n).toString();
const access = (permissions: string) => ({ permissions } as unknown as ServerAccess);

const channelNotice = (extra: Partial<Message> = {}): Message => ({
  id: 'n1', channelId: 'ch', authorId: null as unknown as string, authorUsername: null as unknown as string,
  createdAt: '2026-11-05T10:00:00Z', systemEvent: 'loop_guard',
  content: 'Loop guard: 4 consecutive bot messages. Human input required to continue.',
  systemData: { scope: 'channel', threadId: null, limit: 4 }, ...extra,
});
const threadNotice = (extra: Partial<Message> = {}): Message => channelNotice({
  id: 'n2', content: 'Loop guard: 3 consecutive bot replies in this thread. Human input required to continue.',
  systemData: { scope: 'thread', threadId: 'T1', limit: 3 }, ...extra,
});

beforeEach(() => {
  clearCanManageBotsCache();
  useAuthStore.setState({ user: { id: 'me', username: 'me' } });
  useMessageStore.setState({ byChannel: new Map() });
  useThreadStore.setState({ repliesByThread: new Map() });
  useChannelStore.setState({ channels: new Map([['ch', { id: 'ch', name: 'agents', channelType: 3, serverId: 'srv', maxBotHops: 4, maxThreadBotHops: 3 }]]) });
  vi.spyOn(botApi, 'resumeLoopGuard').mockResolvedValue({ messageId: 'r1', scope: 'channel', threadId: null, limit: 4 });
  vi.spyOn(botApi, 'updateChannelBotConfig').mockImplementation(async (channelId, data) =>
    ({ channelId, maxBotHops: data.maxBotHops ?? 4, maxThreadBotHops: data.maxThreadBotHops ?? 3 }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('LoopGuardNotice', () => {
  it('shows a member that the guard fired, with no controls', async () => {
    const get = vi.spyOn(serverApi, 'getAccess').mockResolvedValue(access('0'));
    render(<LoopGuardNotice message={channelNotice()} />);
    expect(screen.getByText(/4 consecutive bot messages/)).toBeInTheDocument();
    await waitFor(() => expect(get).toHaveBeenCalledWith('srv'));
    expect(screen.queryByRole('group', { name: 'Loop guard actions' })).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('Continue resumes the channel and many notices share one access lookup', async () => {
    const get = vi.spyOn(serverApi, 'getAccess').mockResolvedValue(access(MANAGE_BOTS));
    render(<><LoopGuardNotice message={channelNotice()} /><LoopGuardNotice message={channelNotice({ id: 'n9' })} /></>);
    const [cont] = await screen.findAllByRole('button', { name: 'Continue' });
    expect(get).toHaveBeenCalledTimes(1);
    fireEvent.click(cont);
    expect(await screen.findByText('Agents may continue.')).toBeInTheDocument();
    expect(botApi.resumeLoopGuard).toHaveBeenCalledWith('ch', undefined);
    expect(botApi.updateChannelBotConfig).not.toHaveBeenCalled();
  });

  it('Raise limit doubles the thread guard, updates the header, then resumes that thread', async () => {
    vi.spyOn(serverApi, 'getAccess').mockResolvedValue(access('1')); // Administrator
    render(<LoopGuardNotice message={threadNotice()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Raise limit to 6' }));
    expect(await screen.findByText('Limit raised to 6. Agents may continue.')).toBeInTheDocument();
    expect(botApi.updateChannelBotConfig).toHaveBeenCalledWith('ch', { maxThreadBotHops: 6 });
    expect(botApi.resumeLoopGuard).toHaveBeenCalledWith('ch', 'T1');
    expect(useChannelStore.getState().channels.get('ch')?.maxThreadBotHops).toBe(6);
  });

  it('Turn off removes the channel guard (null) and resumes', async () => {
    vi.spyOn(serverApi, 'getAccess').mockResolvedValue(access(MANAGE_BOTS));
    render(<LoopGuardNotice message={channelNotice()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off in this channel' }));
    expect(await screen.findByText('Loop guard off in this channel. Agents may continue.')).toBeInTheDocument();
    expect(botApi.updateChannelBotConfig).toHaveBeenCalledWith('ch', { maxBotHops: null });
    expect(botApi.resumeLoopGuard).toHaveBeenCalledWith('ch', undefined);
  });

  it('an older thread notice without a thread id can change the guard but not resume', async () => {
    vi.spyOn(serverApi, 'getAccess').mockResolvedValue(access(MANAGE_BOTS));
    render(<LoopGuardNotice message={threadNotice({ systemData: undefined })} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off for threads here' }));
    expect(await screen.findByText('Loop guard off for threads in this channel.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(botApi.updateChannelBotConfig).toHaveBeenCalledWith('ch', { maxThreadBotHops: null });
    expect(botApi.resumeLoopGuard).not.toHaveBeenCalled();
  });

  it('says so when the server refuses', async () => {
    vi.spyOn(serverApi, 'getAccess').mockResolvedValue(access(MANAGE_BOTS));
    vi.mocked(botApi.resumeLoopGuard).mockRejectedValue(new ApiError(403, 'Missing ManageBots permission'));
    render(<LoopGuardNotice message={channelNotice()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no longer have permission');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('drops its buttons once a later resume, guard notice or human post settles it', async () => {
    vi.spyOn(serverApi, 'getAccess').mockResolvedValue(access(MANAGE_BOTS));
    const notice = channelNotice({ id: '01J00000000000000000000001' });
    render(<LoopGuardNotice message={notice} />);
    await screen.findByRole('button', { name: 'Continue' });
    // A bot post after it doesn't settle it; a resume notice does
    act(() => useMessageStore.setState({ byChannel: new Map([['ch', [notice,
      { ...notice, id: '01J00000000000000000000002', systemEvent: undefined, authorBot: true, content: 'still going' }]]]) }));
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
    act(() => useMessageStore.setState({ byChannel: new Map([['ch', [notice,
      { ...notice, id: '01J00000000000000000000003', systemEvent: 'loop_guard_resume', content: 'Agents may continue' }]]]) }));
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('a thread notice is settled by a human reply in that thread', async () => {
    vi.spyOn(serverApi, 'getAccess').mockResolvedValue(access(MANAGE_BOTS));
    const notice = threadNotice({ id: '01J00000000000000000000001' });
    render(<LoopGuardNotice message={notice} />);
    await screen.findByRole('button', { name: 'Continue' });
    act(() => useThreadStore.setState({ repliesByThread: new Map([['T1', [notice,
      { ...notice, id: '01J00000000000000000000002', systemEvent: undefined, authorBot: false, content: 'carry on' }]]]) }));
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('after a saved raise whose resume failed, a retry only resumes', async () => {
    vi.spyOn(serverApi, 'getAccess').mockResolvedValue(access(MANAGE_BOTS));
    vi.mocked(botApi.resumeLoopGuard).mockRejectedValueOnce(new ApiError(500, 'internal'));
    render(<LoopGuardNotice message={channelNotice()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Raise limit to 8' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The new limit is saved, but the agents were not told to continue: internal');
    expect(screen.queryByRole('button', { name: /Raise limit/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Agents may continue.')).toBeInTheDocument();
    expect(botApi.updateChannelBotConfig).toHaveBeenCalledTimes(1);
    expect(botApi.resumeLoopGuard).toHaveBeenCalledTimes(2);
  });

  it('asks again for a different signed-in user', async () => {
    const get = vi.spyOn(serverApi, 'getAccess').mockResolvedValueOnce(access(MANAGE_BOTS)).mockResolvedValueOnce(access('0'));
    const { rerender } = render(<LoopGuardNotice message={channelNotice()} />);
    await screen.findByRole('button', { name: 'Continue' });
    act(() => useAuthStore.setState({ user: { id: 'someone-else', username: 'other' } }));
    rerender(<LoopGuardNotice message={channelNotice()} />);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('button')).toBeNull());
  });
});

describe('loop guard helpers', () => {
  it('reads scope and limit from systemData, or from older notice text', () => {
    expect(loopGuardScope(threadNotice())).toEqual({ scope: 'thread', threadId: 'T1', limit: 3 });
    expect(loopGuardScope(threadNotice({ systemData: undefined }))).toEqual({ scope: 'thread', threadId: null, limit: 3 });
    expect(loopGuardScope(channelNotice({ systemData: undefined }))).toEqual({ scope: 'channel', threadId: null, limit: 4 });
  });
  it('summarises both limits', () => {
    expect(loopGuardSummary({ maxBotHops: 4, maxThreadBotHops: 0 })).toBe('Loop guard: pauses after 4 bot messages in a row; off in threads.');
    expect(loopGuardSummary({ maxBotHops: 0, maxThreadBotHops: 8 })).toBe('Loop guard: off in the channel; threads pause after 8 bot replies in a row.');
  });
});

describe('LoopGuardBadge', () => {
  const channel = (maxBotHops: number, maxThreadBotHops: number) => ({ id: 'ch', name: 'agents', channelType: 3, serverId: 'srv', maxBotHops, maxThreadBotHops });

  it('shows the limits to a member, with no link', async () => {
    vi.spyOn(serverApi, 'getAccess').mockResolvedValue(access('0'));
    render(<MemoryRouter><LoopGuardBadge channel={channel(4, 8)} /></MemoryRouter>);
    const badge = screen.getByRole('img', { name: /pauses after 4 bot messages.*after 8 bot replies/ });
    expect(badge).toHaveTextContent('4 · 8');
    await waitFor(() => expect(serverApi.getAccess).toHaveBeenCalled());
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('links a ManageBots user to the settings', async () => {
    vi.spyOn(serverApi, 'getAccess').mockResolvedValue(access(MANAGE_BOTS));
    render(<MemoryRouter><LoopGuardBadge channel={channel(4, 0)} /></MemoryRouter>);
    const link = await screen.findByRole('link', { name: /off in threads\. Change in agent settings/ });
    expect(link).toHaveAttribute('href', '/settings/agents#loop-guard');
  });

  it('is hidden when both guards are off', () => {
    vi.spyOn(serverApi, 'getAccess').mockResolvedValue(access('0'));
    const { container } = render(<MemoryRouter><LoopGuardBadge channel={channel(0, 0)} /></MemoryRouter>);
    expect(container).toBeEmptyDOMElement();
  });
});
