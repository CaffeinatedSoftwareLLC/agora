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
const get = vi.fn(), post = vi.fn(), patch = vi.fn(), put = vi.fn(), del = vi.fn();
vi.mock('../../lib/api', async (orig) => {
  const actual = await orig<typeof import('../../lib/api')>();
  return { ...actual, api: { ...actual.api, get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), patch: (...a: unknown[]) => patch(...a),
    put: (...a: unknown[]) => put(...a), delete: (...a: unknown[]) => del(...a) } };
});

const CH = 'C'.repeat(26);
const card = (over: Partial<TaskCard> = {}): TaskCard => ({
  id: 'T1', channelId: CH, title: 'Fix login', description: 'Steps', status: 'todo', profile: { id: 'P1', name: 'codex' },
  threadId: null, session: null, prUrl: null, prState: null, prCheckedAt: null, mergedSha: null, issue: null,
  createdBy: null, createdAt: '', updatedAt: '', ...over,
});
const session = { id: 'S'.repeat(26), profile: 'codex', state: 'live' as const, endReason: null, running: true, sleepingUntil: null,
  branch: 'agora/codex/S', baseSha: null, headSha: 'a'.repeat(40), tokensUsed: 1200, tokenBudget: 2_000_000, lastActiveAt: '', changedPaths: ['a.ts'] };

function board(cards: TaskCard[], canManage = true): Board {
  return { cards, canManage, isOwner: canManage };
}
function serve(b: Board, extra: Record<string, unknown> = {}) {
  get.mockImplementation(async (path: string) => {
    if (path.endsWith('/tasks')) return b;
    if (path.endsWith('/agent-profiles')) return [{ id: 'P1', name: 'codex', botId: 'B1', adapter: 'codex' }];
    const key = Object.keys(extra).find(k => path.endsWith(k));
    return key ? extra[key] : {};
  });
}
const LINK = { repo: 'o/r', hostId: 'H1', hostName: 'desk', hostRevoked: false, updatedAt: '' };
const issue = (number: number, cardId: string | null = null) => ({
  number, title: `Bug ${number}`, url: `https://github.com/o/r/issues/${number}`, author: 'octo', updatedAt: '', body: 'Steps', cardId,
});

beforeEach(() => {
  get.mockReset(); post.mockReset(); patch.mockReset(); put.mockReset(); del.mockReset(); socket.on.mockReset(); socket.off.mockReset();
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

  it('links a card to its GitHub issue, https links only', async () => {
    serve(board([
      card({ issue: { repo: 'o/r', number: 7, url: 'https://github.com/o/r/issues/7' } }),
      card({ id: 'T2', title: 'Odd link', issue: { repo: 'o/r', number: 8, url: 'javascript:alert(1)' } }),
    ], false));
    render(<TasksPanel />);
    fireEvent.click(await screen.findByText('Fix login'));
    expect(screen.getByText('o/r#7').getAttribute('href')).toBe('https://github.com/o/r/issues/7');
    fireEvent.click(screen.getByText('Odd link'));
    expect(screen.getByText('o/r#8').tagName).not.toBe('A');
  });

  it('lets the owner link a repository to a live host', async () => {
    serve(board([]), {
      '/github': { link: null, canLink: true, canImport: true },
      '/agent-hosts': [{ id: 'H1', name: 'desk', revokedAt: null }, { id: 'H2', name: 'old', revokedAt: '2026-01-01' }],
    });
    put.mockResolvedValue({ link: LINK });
    render(<TasksPanel />);
    fireEvent.click(await screen.findByText('Link GitHub repo'));
    fireEvent.change(screen.getByLabelText('Repository'), { target: { value: ' o/r ' } });
    await waitFor(() => expect(screen.getByRole('option', { name: 'desk' })).toBeTruthy());
    expect(screen.queryByRole('option', { name: 'old' })).toBeNull();
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(put).toHaveBeenCalledWith(`/channels/${CH}/github`, { repo: 'o/r', hostId: 'H1' }));
    expect(await screen.findByText('Unlink')).toBeTruthy();
    expect(screen.getByText('GitHub via desk')).toBeTruthy();
  });

  it('shows nothing GitHub-related to people who cannot link when no repo is linked', async () => {
    serve(board([], false), { '/github': { link: null, canLink: false, canImport: false } });
    render(<TasksPanel />);
    await screen.findByText(/No cards yet/);
    expect(screen.queryByText('Link GitHub repo')).toBeNull();
  });

  it('lists issues through the host and imports one as a card', async () => {
    serve(board([]), {
      '/github': { link: LINK, canLink: false, canImport: true },
      '/github/commands/CMD': { id: 'CMD', action: 'issue_list', status: 'succeeded', repo: 'o/r', result: { issues: [issue(3), issue(4, 'T9')] } },
    });
    post.mockImplementation(async (path: string) => {
      if (path.endsWith('/github/issues')) return { id: 'CMD', status: 'queued' };
      return { action: 'started', card: card({ id: 'T7', title: 'Bug 3', status: 'in_progress', session, issue: { repo: 'o/r', number: 3, url: null } }) };
    });
    render(<TasksPanel />);
    fireEvent.click(await screen.findByText('Import issue'));
    expect(screen.getByText(/Asking the host for open issues/)).toBeTruthy();
    // No body on the list request, so no JSON Content-Type either
    expect(post).toHaveBeenCalledWith(`/channels/${CH}/github/issues`);
    const list = await screen.findByRole('list', { name: 'Open issues' }, { timeout: 3000 });
    expect(list.textContent).toContain('Bug 4');
    expect(screen.getAllByText('Imported')).toHaveLength(1);
    expect(screen.queryByLabelText('Import issue #4')).toBeNull();

    await waitFor(() => expect(screen.getAllByRole('option', { name: 'codex (codex)' }).length).toBeGreaterThan(0));
    fireEvent.change(screen.getByLabelText('Assignee agent'), { target: { value: 'codex' } });
    fireEvent.click(screen.getByLabelText('Start the agent now'));
    fireEvent.click(screen.getByLabelText('Import issue #3'));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/channels/${CH}/github/issues/import`, { commandId: 'CMD', number: 3, profile: 'codex', start: true }));
    await waitFor(() => expect(screen.getAllByText('Imported')).toHaveLength(2));
    expect(screen.getByRole('region', { name: 'In progress' }).textContent).toContain('Bug 3');
  });

  it('says why the host could not list the issues', async () => {
    serve(board([]), {
      '/github': { link: LINK, canLink: true, canImport: true },
      '/github/commands/CMD': { id: 'CMD', action: 'issue_list', status: 'failed', repo: 'o/r', result: { error: 'gh_not_signed_in' } },
    });
    post.mockResolvedValue({ id: 'CMD', status: 'queued' });
    render(<TasksPanel />);
    fireEvent.click(await screen.findByText('Import issue'));
    expect(await screen.findByText(/gh is not signed in on the host/, undefined, { timeout: 3000 })).toBeTruthy();
  });
});
