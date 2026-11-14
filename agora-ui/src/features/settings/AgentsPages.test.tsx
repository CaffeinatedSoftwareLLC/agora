import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { useServerStore } from '../../stores/serverStore';
import { buildRoster } from './agentRoster';
import { bot, box, host, input, model, profile, session } from './agentRoster.fixtures';
import type { RosterData } from './useAgentRoster';

vi.hoisted(() => vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() }));

let roster: RosterData | null = null;
vi.mock('./useAgentRoster', () => ({ useAgentRoster: () => ({ data: roster, error: '', reload: vi.fn() }) }));
// The parts that load their own data are tested where they live
vi.mock('./AgentSessionsSettings', () => ({
  SubscriptionWakesSection: () => <section aria-label="wakes">Who can wake subscription agents</section>,
  HostsSection: ({ title }: { title?: string }) => <section aria-label="hosts">{title}</section>,
  OnceToken: () => null, CreateAgentForm: () => <div>Create agent form</div>,
  ProfileRow: ({ profile }: { profile: { name: string } }) => <li>Profile settings for {profile.name}</li>,
}));
vi.mock('./BotManagement', () => ({
  ChannelLoopGuardSection: () => <section aria-label="loop guard">Loop Guard</section>,
  BotControls: () => <button>Pause</button>,
  BotDetailPanel: ({ botId }: { botId: string }) => <div>Account panel for {botId}</div>,
}));
vi.mock('./ai/AgentsSection', () => ({ AgentRow: () => <div>Model agent settings</div>, AgentsSection: () => <div>Model agents form</div> }));
vi.mock('../boxes/BoxCard', () => ({ BoxCard: ({ box }: { box: { name: string } }) => <li>Box card for {box.name}</li> }));
vi.mock('../boxes/GithubCredential', () => ({ GithubCredential: () => <div>GitHub token</div> }));
vi.mock('../boxes/api', async importOriginal => ({ ...(await importOriginal<object>()), boxApi: { getGithub: () => Promise.resolve({ set: false }) } }));
vi.mock('../../lib/api', async importOriginal => ({ ...(await importOriginal<object>()), aiApi: { listProviders: () => Promise.resolve([]), listAdapters: () => Promise.resolve([]) } }));

const { AgentsHome } = await import('./AgentsHome');
const { AgentDetail } = await import('./AgentDetail');
const { AddAgent } = await import('./AddAgent');
const { SettingsRoutes } = await import('./SettingsRoutes');

function fill() {
  const rows = buildRoster(input({
    bots: [bot('bot-cci', 'cci'), bot('bot-boxy', 'boxy'), bot('bot-qwen', 'qwen'), bot('bot-term', 'term')],
    hosts: [host('h1'), host('hb', { kind: 'box' })],
    profiles: [profile('cci', 'h1'), profile('boxy', 'hb', { boxed: true })],
    boxes: [box('boxy', { state: 'stopped', desiredState: 'stopped' })],
    modelAgents: [model('qwen', { enabled: false })],
    sessions: [session({ profile: 'cci', botUsername: 'cci', state: 'shelved', endReason: 'budget', limitStop: { kind: 'wake', used: 3, limit: 3, sessionId: 's1' } })],
  }));
  roster = { rows, hosts: [host('h1')], boxes: [box('boxy')], channels: [], plans: [], modelAgents: [], canManageAccounts: true };
}

beforeEach(() => {
  useServerStore.setState({ instanceServerId: 'server', servers: new Map([['server', { id: 'server', ownerId: 'owner' } as never]]) });
  useAuthStore.setState({ user: { id: 'owner', username: 'owner', isInstanceAdmin: true } });
  fill();
});
afterEach(() => { cleanup(); roster = null; });

const at = (path: string, ui: React.ReactNode, route = path) => render(<MemoryRouter initialEntries={[path]}><Routes><Route path={route} element={ui} /></Routes></MemoryRouter>);

describe('Agents home', () => {
  it('lists every agent once, with how it runs and what it is doing', () => {
    at('/settings/agents', <AgentsHome />);
    const list = screen.getByRole('list', { name: 'Agents' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    const byName = (name: string) => items.find(li => within(li).queryByText(name))!;
    expect(within(byName('boxy')).getByTestId('agent-kind')).toHaveTextContent('In a box');
    expect(within(byName('cci')).getByTestId('agent-kind')).toHaveTextContent('On this machine');
    expect(within(byName('qwen')).getByTestId('agent-kind')).toHaveTextContent('Model on an API key');
    expect(within(byName('term')).getByTestId('agent-kind')).toHaveTextContent('Connected from a terminal');
  });

  it('says why a stopped agent is stopped', () => {
    at('/settings/agents', <AgentsHome />);
    const state = (name: string) => within(screen.getAllByRole('listitem').find(li => within(li).queryByText(name))!).getByTestId('agent-state');
    expect(state('boxy')).toHaveTextContent('Stopped: The box is stopped.');
    expect(state('qwen')).toHaveTextContent('Stopped: It is switched off in its settings.');
    expect(state('cci')).toHaveTextContent(/Stopped: Stopped by the wake limit: 3 of 3 wakes/);
    expect(state('term')).toHaveTextContent('Not connected');
  });

  it('opens an agent, offers Add an agent, and filters by name', () => {
    at('/settings/agents', <AgentsHome />);
    expect(screen.getByRole('link', { name: 'Add an agent' })).toHaveAttribute('href', '/settings/agents/new');
    expect(screen.getByRole('link', { name: /cci/ })).toHaveAttribute('href', '/settings/agents/bot-cci');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search agents' }), { target: { value: 'qw' } });
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('1 of 4 agents')).toBeTruthy();
  });

  it('keeps the settings that apply to all agents below the list', () => {
    at('/settings/agents', <AgentsHome />);
    expect(screen.getByRole('heading', { name: 'For all agents' })).toBeTruthy();
    expect(screen.getByText('Who can wake subscription agents')).toBeTruthy();
    expect(screen.getByText('Loop Guard')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Machines' })).toBeTruthy();
  });

  it('shows an empty state that points at Add an agent', () => {
    roster = { ...roster!, rows: [] };
    at('/settings/agents', <AgentsHome />);
    expect(screen.getByText(/No agents yet/)).toBeTruthy();
  });

  it('hides the loop guard from someone who may not manage bots', () => {
    roster = { ...roster!, canManageAccounts: false };
    at('/settings/agents', <AgentsHome />);
    expect(screen.queryByText('Loop Guard')).toBeNull();
  });
});

describe('Agent detail', () => {
  const open = (key: string) => at(`/settings/agents/${key}`, <AgentDetail />, '/settings/agents/:agentKey');
  const headings = () => screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent);

  it('gathers a machine agent: how it runs, settings and limits, sessions, account', () => {
    open('bot-cci');
    expect(screen.getByRole('heading', { name: 'cci' })).toBeTruthy();
    expect(headings()).toEqual(['How it runs', 'Settings, limits and logins', 'Sessions', 'Account and access']);
    expect(screen.getByText('Profile settings for cci')).toBeTruthy();
    expect(screen.getByText('Account panel for bot-cci')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'All agents' })).toHaveAttribute('href', '/settings/agents');
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
  });

  it('adds the box and login for a boxed agent, found by its account', () => {
    open('bot-boxy');
    expect(headings()).toEqual(['How it runs', 'Box and login', 'Limits and tools', 'Sessions', 'Account and access']);
    expect(screen.getByText('Box card for boxy')).toBeTruthy();
    expect(screen.getByTestId('agent-state')).toHaveTextContent('Stopped: The box is stopped.');
  });

  it('shows the model section for a model agent and no session limits', () => {
    open('bot-qwen');
    expect(headings()).toEqual(['How it runs', 'Model and limits', 'Sessions', 'Account and access']);
  });

  it('explains a terminal agent and its empty sessions', () => {
    open('bot-term');
    expect(headings()).toEqual(['How it runs', 'Sessions', 'Account and access']);
    expect(screen.getByText(/No sessions yet/)).toBeTruthy();
  });

  it('keeps tokens and channel access to people who may manage bots', () => {
    roster = { ...roster!, canManageAccounts: false };
    open('bot-cci');
    expect(screen.queryByText('Account panel for bot-cci')).toBeNull();
    expect(screen.getByText(/need the Manage Bots permission/)).toBeTruthy();
  });

  it('says so when the agent is gone', () => {
    open('nobody');
    expect(screen.getByRole('heading', { name: 'Agent not found' })).toBeTruthy();
  });
});

describe('Add an agent', () => {
  it('asks how it should run with one choice per way, and leads into the existing flow', () => {
    at('/settings/agents/new', <AddAgent />);
    const group = screen.getByRole('radiogroup', { name: 'How should it run?' });
    expect(within(group).getAllByRole('radio')).toHaveLength(4);
    fireEvent.click(within(group).getByRole('radio', { name: /In a box/ }));
    expect(screen.getByRole('button', { name: 'Create box' })).toBeTruthy();
    fireEvent.click(within(group).getByRole('radio', { name: /From someone's own terminal/ }));
    expect(screen.getByRole('button', { name: 'Invite Agent' })).toBeTruthy();
    fireEvent.click(within(group).getByRole('radio', { name: /one of my machines/ }));
    expect(screen.getByText('Create agent form')).toBeTruthy();
  });

  it('tells a non-owner that boxes and machines are the owner’s', () => {
    useAuthStore.setState({ user: { id: 'member', username: 'member', isInstanceAdmin: false } });
    at('/settings/agents/new?how=box', <AddAgent />, '/settings/agents/new');
    expect(screen.getByText('Only the server owner can do this.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create box' })).toBeNull();
  });
});

describe('old settings addresses', () => {
  function Where() { const l = useLocation(); return <p data-testid="where">{l.pathname}</p>; }
  const go = (path: string) => render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/settings/*" element={<><Where /><SettingsRoutes /></>} /></Routes></MemoryRouter>);

  it('sends Bots to Agents', () => {
    go('/settings/bots');
    expect(screen.getByTestId('where')).toHaveTextContent('/settings/agents');
    expect(screen.getByRole('heading', { name: 'Agents' })).toBeTruthy();
  });
  it('sends AI to Models and assistant', async () => {
    go('/settings/ai');
    expect(screen.getByTestId('where')).toHaveTextContent('/settings/models');
  });
});
