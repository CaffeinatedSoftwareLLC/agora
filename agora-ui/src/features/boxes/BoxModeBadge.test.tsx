import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { api, serverApi } from '../../lib/api';
import { useServerStore } from '../../stores/serverStore';
import { useChannelStore } from '../../stores/channelStore';
import { useMessageStore } from '../../stores/messageStore';
import { useThreadStore } from '../../stores/threadStore';
import { AgentSessionsSettings } from '../settings/AgentSessionsSettings';
import { ConsoleStrip } from '../agents/ConsoleStrip';
import { SessionSheet } from '../agents/SessionSheet';
import { describeSession, type AgentSession } from '../agents/agentSessions';
import { BoxModeBadge } from './BoxModeBadge';
import { boxModeLabel } from './boxRules';

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} }); });
const socket = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn() }));
vi.mock('../../hooks/useSocket', () => ({ useSocket: () => socket }));

const session = (over: Partial<AgentSession>): AgentSession => ({
  id: 'A'.repeat(26), profile: 'builder', botUsername: 'builder', state: 'live', endReason: null,
  wakesUsed: 1, tokensUsed: 10, lastActiveAt: '2026-11-04T10:00:00Z', running: false, ...over,
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('boxed / unboxed label (§10)', () => {
  it('reads boxed first, else unboxed; nothing when the API sends neither', () => {
    expect(boxModeLabel({ boxed: true, hostMode: false })).toBe('boxed');
    expect(boxModeLabel({ boxed: false, hostMode: true })).toBe('unboxed');
    expect(boxModeLabel({ boxed: false })).toBe('unboxed');
    expect(boxModeLabel({ hostMode: true })).toBe('unboxed');
    expect(boxModeLabel({})).toBeNull();
    expect(boxModeLabel(undefined)).toBeNull();
  });

  it('renders the badge', () => {
    render(<><BoxModeBadge profile={{ boxed: true }} /><BoxModeBadge profile={{ hostMode: true }} /><BoxModeBadge profile={{}} /></>);
    expect(screen.getAllByTestId('box-mode').map(b => b.textContent)).toEqual(['boxed', 'unboxed']);
  });

  it('is in /sessions output', () => {
    expect(describeSession(session({ boxed: true }))).toMatch(/^builder \(boxed\) · live/);
    expect(describeSession(session({ boxed: false, hostMode: true }))).toMatch(/^builder \(unboxed\) · live/);
    expect(describeSession(session({}))).toMatch(/^builder · live/);
  });

  it('labels Settings → Agents rows', async () => {
    useServerStore.setState({ instanceServerId: 'S' });
    const profile = (id: string, name: string, extra: object) => ({ id, name, botId: `B${id}`, hostId: 'H', adapter: 'claude',
      model: null, effort: null, workdirAlias: 'work', workspaceId: 'primary', wakeBudget: 50, tokenBudget: 1000, runTimeoutSec: 900, ...extra });
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => (path.endsWith('/agent-hosts')
      ? [{ id: 'H', name: 'desktop', revokedAt: null, kind: 'machine' }, { id: 'X', name: 'box-builder', revokedAt: null, kind: 'box' }]
      : path.endsWith('/agent-profiles') ? [profile('P1', 'local', { boxed: false, hostMode: true }), profile('P2', 'builder', { boxed: true, hostMode: false, hostId: 'X' })]
      : path.endsWith('/boxes') ? { boxes: [] } : []) as never);
    vi.spyOn(serverApi, 'getChannels').mockResolvedValue([]);
    render(<AgentSessionsSettings />);
    const local = await screen.findByText('local');
    expect(within(local.closest('li')!).getByTestId('box-mode')).toHaveTextContent('unboxed');
    expect(within(screen.getByText('builder').closest('li')!).getByTestId('box-mode')).toHaveTextContent('boxed');
    // A box's host is listed with its box, not under Hosts
    expect(screen.queryByText('box-builder')).toBeNull();
    expect(screen.getAllByText('desktop').length).toBeGreaterThan(0);
    useServerStore.setState({ instanceServerId: null });
  });

  describe('agent strip and session sheet', () => {
    const CH = 'C'.repeat(26);
    beforeEach(() => {
      useChannelStore.setState({ channels: new Map([[CH, { id: CH, name: 'general', channelType: 0, serverId: 'SRV' }]]) });
      useMessageStore.setState({ byChannel: new Map() });
      useThreadStore.setState({ activeThreads: new Map(), repliesByThread: new Map(), loadActiveThreads: async () => {} });
    });

    it('labels the chip', async () => {
      vi.spyOn(api, 'post').mockResolvedValue({ sessions: [session({ boxed: true }), session({ id: 'Z'.repeat(26), profile: 'local', botUsername: 'local', hostMode: true })] } as never);
      vi.spyOn(api, 'get').mockResolvedValue([] as never);
      render(<ConsoleStrip channelId={CH} onOpenThread={vi.fn()} />);
      const chip = await screen.findByRole('button', { name: /^builder \(boxed\)/ });
      expect(within(chip).getByTestId('box-mode')).toHaveTextContent('boxed');
      expect(within(screen.getByRole('button', { name: /^local \(unboxed\)/ })).getByTestId('box-mode')).toHaveTextContent('unboxed');
    });

    it('labels the sheet\'s agent list and status line', () => {
      const props = { open: true, onClose: vi.fn(), channelId: CH, sessions: [session({ boxed: true })], onChanged: vi.fn() };
      const profiles = [{ id: 'P1', name: 'builder', botId: 'B', adapter: 'claude', boxed: true }, { id: 'P2', name: 'local', botId: 'L', adapter: 'codex', hostMode: true }];
      const { unmount } = render(<SessionSheet {...props} mode={{ kind: 'start' }} profiles={profiles} />);
      expect(screen.getAllByTestId('box-mode').map(b => b.textContent)).toEqual(['boxed', 'unboxed']);
      unmount();
      render(<SessionSheet {...props} mode={{ kind: 'profile', profile: 'builder' }} profiles={null} />);
      expect(screen.getByTestId('box-mode')).toHaveTextContent('boxed');
    });
  });
});
