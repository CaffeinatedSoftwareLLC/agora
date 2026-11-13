import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { api } from '../../lib/api';
import { useAuthStore } from '../../stores/authStore';
import { useMessageStore, type Message } from '../../stores/messageStore';
import { useThreadStore } from '../../stores/threadStore';
import { useUIStore } from '../../stores/uiStore';
import { ThreadPanel } from './ThreadPanel';
import type { RunStreamView } from '../agents/runStream';

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() }); });
vi.mock('../agents/handoffs', () => ({ useThreadOwner: () => null }));
vi.mock('../voice/MicButton', () => ({ MicButton: () => null }));
const streams = vi.hoisted(() => ({ current: {} as Record<string, RunStreamView> }));
vi.mock('../agents/runStream', async orig => ({ ...await orig<typeof import('../agents/runStream')>(), useRunStreams: () => streams.current }));

const parent: Message = { id: 'parent', channelId: 'channel', content: 'Plan', authorId: 'me', authorUsername: 'me', createdAt: '2026-11-05T10:00:00Z', replyCount: 0 };
const view = (over: Partial<RunStreamView>): RunStreamView => ({ runId: 'run', sessionId: 's', threadId: 'parent', profile: 'claude', seq: 1, text: 'Checking the build', textTruncated: false,
  steps: [{ step: 'a', tool: 'Read', label: 'Read src/app.ts', state: 'running' }], ...over });

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'get').mockResolvedValue([]);
  useAuthStore.setState({ user: { id: 'me', username: 'me' } });
  useMessageStore.setState({ byChannel: new Map([['channel', [parent]]]) });
  useThreadStore.getState().clear();
  useThreadStore.setState({ openThreadId: 'parent', openThreadChannelId: 'channel', repliesByThread: new Map([['parent', []]]) });
  useUIStore.setState({ activeOverlay: null });
});

it('shows the live output of an agent working on this thread, above the reply box', () => {
  streams.current = { run: view({}) };
  render(<ThreadPanel />);
  const block = screen.getByRole('region', { name: 'claude live output' });
  expect(block).toHaveTextContent('Checking the build');
  expect(block).toHaveTextContent('Read src/app.ts');
});

it('does not show the live output of a run in another thread or the channel', () => {
  streams.current = { run: view({ threadId: 'other-thread' }), run2: view({ runId: 'run2', threadId: null }) };
  render(<ThreadPanel />);
  expect(screen.queryByTestId('live-work')).toBeNull();
});

it('shows nothing once the run has ended (its stream is gone)', () => {
  streams.current = {};
  render(<ThreadPanel />);
  expect(screen.queryByTestId('live-work')).toBeNull();
});
