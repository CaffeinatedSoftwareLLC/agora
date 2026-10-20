import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiError } from '../../lib/api';
import { useChannelStore } from '../../stores/channelStore';
import { useUIStore } from '../../stores/uiStore';
import { TasksPanel } from './TasksPanel';
import { cardSessionState, groupCards, safeUrl, taskError, upsertCard, type Board, type TaskCard } from './taskBoard';
import { deriveChips, type AgentSession } from '../agents/agentSessions';

vi.hoisted(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
});

const socket = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn() }));
vi.mock('../../hooks/useSocket', () => ({ useSocket: () => socket }));
const get = vi.fn(), post = vi.fn(), patch = vi.fn();
vi.mock('../../lib/api', async (orig) => {
  const actual = await orig<typeof import('../../lib/api')>();
  return { ...actual, api: { ...actual.api, get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), patch: (...a: unknown[]) => patch(...a) } };
});

const CH = 'C'.repeat(26);
const card = (over: Partial<TaskCard> = {}): TaskCard => ({
  id: 'T1', channelId: CH, title: 'Fix login', description: 'Steps', status: 'todo', profile: { id: 'P1', name: 'codex' },
  threadId: null, session: null, prUrl: null, prState: null, prCheckedAt: null, mergedSha: null,
  createdBy: null, createdAt: '', updatedAt: '', ...over,
});
const session = { id: 'S'.repeat(26), profile: 'codex', state: 'live' as const, endReason: null, running: true, sleepingUntil: null,
  branch: 'agora/codex/S', baseSha: null, headSha: 'a'.repeat(40), tokensUsed: 1200, tokenBudget: 2_000_000, lastActiveAt: '', changedPaths: ['a.ts'] };

function board(cards: TaskCard[], canManage = true): Board {
  return { cards, canManage, isOwner: canManage };
}
function serve(b: Board) {
  get.mockImplementation(async (path: string) => {
    if (path.endsWith('/tasks')) return b;
    if (path.endsWith('/agent-profiles')) return [{ id: 'P1', name: 'codex', botId: 'B1', adapter: 'codex' }];
    return {};
  });
}

beforeEach(() => {
  get.mockReset(); post.mockReset(); patch.mockReset(); socket.on.mockReset(); socket.off.mockReset();
  useChannelStore.setState({ activeChannelId: CH, channels: new Map([[CH, { id: CH, name: 'general', channelType: 3, serverId: 'SRV' }]]) } as never);
  useUIStore.setState({ aux: 'tasks' });
});

describe('task board helpers', () => {
  it('groups by status in creation order and replaces cards in place', () => {
    const groups = groupCards([card({ id: 'T3', status: 'done' }), card({ id: 'T2' }), card({ id: 'T1' })]);
    expect(groups.todo.map(c => c.id)).toEqual(['T1', 'T2']);
    expect(groups.done.map(c => c.id)).toEqual(['T3']);
    const list = upsertCard([card()], card({ title: 'Renamed' }));
    expect(list.map(c => c.title)).toEqual(['Renamed']);
    expect(upsertCard(list, card({ id: 'T9' }))).toHaveLength(2);
  });
  it('reads the session state, keeps only https PR links and explains errors', () => {
    expect(cardSessionState(card())).toBe('none');
    expect(cardSessionState(card({ session }))).toBe('working');
    expect(cardSessionState(card({ session: { ...session, state: 'shelved' } }))).toBe('shelved');
    expect(safeUrl('https://github.com/o/r/pull/1')).toBe('https://github.com/o/r/pull/1');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(taskError(new ApiError(409, 'card_session_live'))).toMatch(/End its session/);
    expect(taskError(new ApiError(403, 'cannot_direct'))).toMatch(/Only the owner and directors/);
  });
  it('keeps task card and subtask sessions out of the Console Strip chips', () => {
    const s = (over: Partial<AgentSession>): AgentSession => ({ id: 'X', profile: 'codex', botUsername: 'codex', state: 'live', endReason: null,
      wakesUsed: 0, tokensUsed: 0, lastActiveAt: '', ...over });
    const chips = deriveChips([s({ id: 'card', threadId: 'TH', running: true }), s({ id: 'channel', running: false })]);
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({ state: 'idle', session: { id: 'channel' } });
  });
});

describe('TasksPanel', () => {
  it('shows cards by status, and only managers get the controls', async () => {
    serve(board([card(), card({ id: 'T2', title: 'Ship', status: 'review', session, threadId: 'TH', prUrl: 'https://github.com/o/r/pull/2', prState: 'open' })], false));
    render(<TasksPanel />);
    expect(await screen.findByText('Fix login')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Review' })).toBeTruthy();
    expect(screen.queryByText('New card')).toBeNull();
    fireEvent.click(screen.getByText('Ship'));
    expect(screen.getByText('agora/codex/S @ aaaaaaaaaaaa')).toBeTruthy();
    expect(screen.getByText('Pull request (open)').getAttribute('href')).toBe('https://github.com/o/r/pull/2');
    expect(screen.getByText('Open thread')).toBeTruthy();
    expect(screen.queryByText('End session')).toBeNull();
    expect(screen.queryByLabelText('Status')).toBeNull();
  });

  it('creates a card and starts its agent', async () => {
    serve(board([]));
    post.mockResolvedValue({ action: 'started', card: card({ status: 'in_progress', session, threadId: 'TH' }) });
    render(<TasksPanel />);
    fireEvent.click(await screen.findByText('New card'));
    fireEvent.change(screen.getAllByLabelText('Card title')[0], { target: { value: 'Fix login' } });
    await waitFor(() => expect(screen.getAllByRole('option', { name: 'codex (codex)' }).length).toBeGreaterThan(0));
    fireEvent.change(screen.getAllByLabelText('Assignee agent')[0], { target: { value: 'codex' } });
    fireEvent.click(screen.getByLabelText('Start the agent now'));
    fireEvent.click(screen.getByText('Add card'));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/channels/${CH}/tasks`, { title: 'Fix login', description: '', profile: 'codex', start: true }));
    expect(await screen.findByText(/Agent working/)).toBeTruthy();
  });

  it('starts a card, moves it, and follows TaskCardUpdate events', async () => {
    serve(board([card()]));
    render(<TasksPanel />);
    fireEvent.click(await screen.findByText('Fix login'));
    post.mockResolvedValue({ action: 'started', card: card({ status: 'in_progress', session, threadId: 'TH' }) });
    fireEvent.click(screen.getByText('Start'));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/channels/${CH}/tasks/T1/start`));
    // The card moves to In progress and stays open there
    await waitFor(() => expect(screen.getByRole('region', { name: 'In progress' }).textContent).toContain('Agent working'));

    patch.mockResolvedValue({ card: card({ status: 'review', session, threadId: 'TH' }) });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'review' } });
    await waitFor(() => expect(patch).toHaveBeenCalledWith(`/channels/${CH}/tasks/T1`, { status: 'review' }));

    const onUpdate = socket.on.mock.calls.find(c => c[0] === 'TaskCardUpdate')![1];
    act(() => onUpdate({ channelId: CH, card: card({ id: 'T5', title: 'From an agent', status: 'todo' }) }));
    expect(screen.getByText('From an agent')).toBeTruthy();
    const onDelete = socket.on.mock.calls.find(c => c[0] === 'TaskCardDelete')![1];
    act(() => onDelete({ channelId: CH, id: 'T5' }));
    expect(screen.queryByText('From an agent')).toBeNull();
  });
});
