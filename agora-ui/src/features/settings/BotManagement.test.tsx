import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApiError, botApi, serverApi } from '../../lib/api';
import type { Bot, BotDetail } from '../../lib/api';
import { useServerStore } from '../../stores/serverStore';
import { useChannelStore } from '../../stores/channelStore';
import { BotManagement } from './BotManagement';

vi.hoisted(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
});
// The real virtualizer with a 600 px viewport: jsdom has no layout or ResizeObserver
vi.mock('@tanstack/react-virtual', async importOriginal => {
  const actual = await importOriginal<typeof import('@tanstack/react-virtual')>();
  return { ...actual, useVirtualizer: (options: Parameters<typeof actual.useVirtualizer>[0]) => actual.useVirtualizer({
    ...options, initialRect: { width: 800, height: 600 },
    observeElementRect: (_instance, callback) => { callback({ width: 800, height: 600 }); return () => {}; },
    // Tests scroll by calling the latest offset callback
    observeElementOffset: (_instance, callback) => { (globalThis as { scrollBots?: (o: number, s: boolean) => void }).scrollBots = callback; callback(0, false); return () => {}; },
    scrollToFn: () => {},
    measureElement: () => 60,
  }) };
});

const N = 2000;
const bots: Bot[] = Array.from({ length: N }, (_, i) => ({
  id: `B${String(i).padStart(25, '0')}`, username: `bot-${i}`, ownerId: null,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), avatarUrl: null,
  pausedAt: null, pausedReason: null, runtimeAccess: 'none',
}));
const detail = (bot: Bot): BotDetail => ({ ...bot, canManageTokens: false, channels: [] } as unknown as BotDetail);

beforeEach(() => {
  useServerStore.setState({ instanceServerId: 'server' });
  vi.spyOn(botApi, 'list').mockResolvedValue(bots);
  vi.spyOn(serverApi, 'getChannels').mockResolvedValue([]);
  vi.spyOn(botApi, 'get').mockImplementation(async (_s, id) => detail(bots.find(b => b.id === id)!));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const rows = () => screen.getAllByRole('button', { name: /^bot-\d+/ });

test('2,000 bots mount only the rows in view, newest first', async () => {
  render(<MemoryRouter><BotManagement /></MemoryRouter>);
  await screen.findByText('bot-1999');
  expect(rows().length).toBeLessThan(40);
  expect(rows()[0]).toHaveTextContent('bot-1999');
  expect(screen.queryByText('bot-0')).toBeNull();
  expect(screen.getByText('2000 bots')).toBeInTheDocument();
  expect(document.body.getElementsByTagName('*').length).toBeLessThan(1000);
});

test('opening a bot re-renders that row, not the whole list, and loads only its detail', async () => {
  // Each row render formats its creation date once
  const rowRenders = vi.spyOn(Date.prototype, 'toLocaleDateString');
  render(<MemoryRouter><BotManagement /></MemoryRouter>);
  await screen.findByText('bot-1999');
  rowRenders.mockClear();
  fireEvent.click(screen.getByText('bot-1995'));
  await screen.findByText('Delete Bot');
  expect(rowRenders.mock.calls.length).toBeLessThanOrEqual(2);
  expect(botApi.get).toHaveBeenCalledTimes(1);
  expect(botApi.get).toHaveBeenCalledWith('server', bots[1995].id);
  expect(screen.getByRole('button', { name: /^bot-1995/ })).toHaveAttribute('aria-expanded', 'true');

  // Nothing re-renders the list while it sits idle
  rowRenders.mockClear();
  await act(async () => { await new Promise(r => setTimeout(r, 1500)); });
  expect(rowRenders).not.toHaveBeenCalled();
});

test('search finds a bot anywhere in the list', async () => {
  render(<MemoryRouter><BotManagement /></MemoryRouter>);
  await screen.findByText('bot-1999');
  fireEvent.change(screen.getByLabelText('Search bots'), { target: { value: 'BOT-7' } });
  // bot-7, bot-70..79, bot-700..799: 111 matches
  expect(await screen.findByText('111 of 2000 bots')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Search bots'), { target: { value: 'bot-0' } });
  expect(await screen.findByText('1 of 2000 bots')).toBeInTheDocument();
  const list = screen.getByTestId('bot-list');
  expect(within(list).getByText('bot-0')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Search bots'), { target: { value: 'nobody' } });
  expect(await screen.findByText(/No bots match/)).toBeInTheDocument();
});

test('pausing refreshes the list in place instead of blanking the page', async () => {
  vi.spyOn(botApi, 'setPaused').mockResolvedValue({ id: bots[1999].id, pausedAt: 'now', pausedReason: null });
  vi.spyOn(window, 'prompt').mockReturnValue('');
  render(<MemoryRouter><BotManagement /></MemoryRouter>);
  await screen.findByText('bot-1999');
  fireEvent.click(screen.getAllByRole('button', { name: 'Pause' })[0]);
  await act(async () => {});
  expect(botApi.list).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('Loading bots...')).toBeNull();
  expect(screen.getByText('bot-1999')).toBeInTheDocument();
});

test('Loop Guard shows both limits per channel with on/off switches (#23)', async () => {
  vi.mocked(serverApi.getChannels).mockResolvedValue([
    { id: 'C1', name: 'agents', channelType: 3, serverId: 'server', maxBotHops: 4, maxThreadBotHops: 0 },
    { id: 'V1', name: 'voice', channelType: 5, serverId: 'server' },
  ]);
  const patch = vi.spyOn(botApi, 'updateChannelBotConfig').mockImplementation(async (channelId, data) =>
    ({ channelId, maxBotHops: data.maxBotHops ?? 4, maxThreadBotHops: data.maxThreadBotHops ?? 0 }));
  render(<MemoryRouter><BotManagement /></MemoryRouter>);
  const channelSwitch = await screen.findByRole('switch', { name: 'Channel loop guard in #agents' });
  const threadSwitch = screen.getByRole('switch', { name: 'Threads loop guard in #agents' });
  expect(screen.queryByText('#voice')).toBeNull();
  expect(channelSwitch).toBeChecked();
  expect(threadSwitch).not.toBeChecked();
  expect(screen.getByLabelText('Channel limit in #agents (bot messages)')).toHaveValue(4);

  fireEvent.click(threadSwitch);
  await waitFor(() => expect(patch).toHaveBeenCalledWith('C1', { maxThreadBotHops: 4 }));
  expect(screen.getByLabelText('Threads limit in #agents (bot replies in one thread)')).toHaveValue(4);

  // A typed limit saves after a pause; switching off and on again restores it
  vi.useFakeTimers();
  try {
    fireEvent.change(screen.getByLabelText('Channel limit in #agents (bot messages)'), { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText('Channel limit in #agents (bot messages)'), { target: { value: '0' } });
    expect(screen.getByLabelText('Channel limit in #agents (bot messages)')).toHaveValue(9);
    await act(async () => { vi.advanceTimersByTime(700); });
  } finally { vi.useRealTimers(); }
  await waitFor(() => expect(patch).toHaveBeenCalledWith('C1', { maxBotHops: 9 }));
  fireEvent.click(channelSwitch);
  await waitFor(() => expect(patch).toHaveBeenCalledWith('C1', { maxBotHops: 0 }));
  expect(channelSwitch).not.toBeChecked();
  fireEvent.click(channelSwitch);
  await waitFor(() => expect(patch).toHaveBeenLastCalledWith('C1', { maxBotHops: 9 }));
});

test('the open bot stays mounted when its row scrolls out of view', async () => {
  render(<MemoryRouter><BotManagement /></MemoryRouter>);
  await screen.findByText('bot-1999');
  fireEvent.click(screen.getByText('bot-1995'));
  await screen.findByText('Delete Bot');
  const scroll = (globalThis as { scrollBots?: (o: number, s: boolean) => void }).scrollBots!;
  act(() => scroll(60 * 1000, true));
  expect(await screen.findByText('bot-999')).toBeInTheDocument();
  expect(screen.getByText('bot-1995')).toBeInTheDocument();
  expect(screen.getByText('Delete Bot')).toBeInTheDocument();
  expect(screen.queryByText('bot-1990')).toBeNull();
});

describe('Loop Guard saves', () => {
  const agents = { id: 'C1', name: 'agents', channelType: 3, serverId: 'server', maxBotHops: 4, maxThreadBotHops: 0 };
  const limit = () => screen.getByLabelText('Channel limit in #agents (bot messages)');
  beforeEach(() => {
    vi.mocked(serverApi.getChannels).mockResolvedValue([agents]);
    useChannelStore.setState({ channels: new Map([['C1', agents]]) });
  });

  it('sends a change still in its debounce when the page closes', async () => {
    const patch = vi.spyOn(botApi, 'updateChannelBotConfig').mockResolvedValue({ channelId: 'C1', maxBotHops: 7, maxThreadBotHops: 0 });
    const { unmount } = render(<MemoryRouter><BotManagement /></MemoryRouter>);
    await screen.findByLabelText('Channel limit in #agents (bot messages)');
    fireEvent.change(limit(), { target: { value: '7' } });
    unmount();
    await waitFor(() => expect(patch).toHaveBeenCalledWith('C1', { maxBotHops: 7 }));
    await waitFor(() => expect(useChannelStore.getState().channels.get('C1')?.maxBotHops).toBe(7));
  });

  it('sends a change still in its debounce after the save in flight when the page closes', async () => {
    const calls: number[] = [];
    let release: (() => void) | undefined;
    vi.spyOn(botApi, 'updateChannelBotConfig').mockImplementation(async (_c, data) => {
      calls.push(data.maxBotHops!);
      if (calls.length === 1) await new Promise<void>(r => { release = r; });
      return { channelId: 'C1', maxBotHops: data.maxBotHops!, maxThreadBotHops: 0 };
    });
    const { unmount } = render(<MemoryRouter><BotManagement /></MemoryRouter>);
    await screen.findByLabelText('Channel limit in #agents (bot messages)');
    fireEvent.change(limit(), { target: { value: '7' } });
    await waitFor(() => expect(calls).toEqual([7]), { timeout: 2000 });
    // 9 is still in its 600 ms debounce when the page closes
    fireEvent.change(limit(), { target: { value: '9' } });
    unmount();
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(calls).toEqual([7]);
    release!();
    await waitFor(() => expect(calls).toEqual([7, 9]));
    await waitFor(() => expect(useChannelStore.getState().channels.get('C1')?.maxBotHops).toBe(9));
  });

  it('shows the saved value again when a save fails', async () => {
    vi.spyOn(botApi, 'updateChannelBotConfig').mockRejectedValue(new ApiError(403, 'Missing ManageBots permission'));
    render(<MemoryRouter><BotManagement /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('switch', { name: 'Channel loop guard in #agents' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Missing ManageBots permission');
    expect(screen.getByRole('switch', { name: 'Channel loop guard in #agents' })).toBeChecked();
    expect(limit()).toHaveValue(4);
  });

  it('follows a change made elsewhere, such as Raise limit on a notice', async () => {
    render(<MemoryRouter><BotManagement /></MemoryRouter>);
    await screen.findByLabelText('Channel limit in #agents (bot messages)');
    act(() => useChannelStore.getState().patchChannel('C1', { maxBotHops: 8, maxThreadBotHops: 2 }));
    expect(limit()).toHaveValue(8);
    expect(screen.getByRole('switch', { name: 'Threads loop guard in #agents' })).toBeChecked();
  });

  it('sends saves of one field in order, one at a time', async () => {
    const calls: number[] = [];
    let release: (() => void) | undefined;
    vi.spyOn(botApi, 'updateChannelBotConfig').mockImplementation(async (_c, data) => {
      calls.push(data.maxBotHops!);
      if (calls.length === 1) await new Promise<void>(r => { release = r; });
      return { channelId: 'C1', maxBotHops: data.maxBotHops!, maxThreadBotHops: 0 };
    });
    render(<MemoryRouter><BotManagement /></MemoryRouter>);
    const sw = await screen.findByRole('switch', { name: 'Channel loop guard in #agents' });
    fireEvent.click(sw); // off
    await waitFor(() => expect(calls).toEqual([0]));
    fireEvent.click(sw); // back on while the first save is still out
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(calls).toEqual([0]);
    release!();
    await waitFor(() => expect(calls).toEqual([0, 4]));
    expect(sw).toBeChecked();
  });
});
