import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProjectPanel } from './ProjectPanel';
import { useChannelStore } from '../../stores/channelStore';
import type { ChannelProject } from '../../lib/api';

// Node 25's own localStorage shadows jsdom's; uiStore reads it on import
vi.hoisted(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
});

type Handler = (payload: unknown) => void;
const handlers = new Map<string, Handler>();
const socket = { on: (e: string, h: Handler) => { handlers.set(e, h); }, off: (e: string) => { handlers.delete(e); } };
vi.mock('../../hooks/useSocket', () => ({ useSocket: () => socket }));

const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), setVerify: vi.fn(), search: vi.fn() }));
vi.mock('../../lib/api', async (orig) => {
  const real = await orig<typeof import('../../lib/api')>();
  return {
    ...real,
    projectApi: { get: mocks.get, update: mocks.update, setVerify: mocks.setVerify },
    fileSearchApi: { search: mocks.search, tagNames: vi.fn(async () => []) },
  };
});

const base: ChannelProject = {
  channelId: 'C1', instructions: 'Use npm.', version: 2,
  files: [{ id: 'F1', name: 'spec.md', mime: 'text/markdown', size: 10 }],
  verify: null, updatedAt: null, updatedBy: 'owner', canEdit: true, canEditVerify: true,
};
const file = (id: string, name: string) => ({ id, name, size: 1, uploadedAt: '2026-10-19T00:00:00Z', url: `/files/${id}`, tags: [], tagging: 'none', partial: false, injectionWarning: false, score: 1, ranked: false });

beforeEach(() => {
  useChannelStore.setState({ activeChannelId: 'C1' });
  mocks.get.mockResolvedValue(base);
  mocks.search.mockResolvedValue({ query: null, tag: null, results: [file('F1', 'spec.md'), file('F2', 'notes.txt')], ranking: { status: 'coarse' } });
  mocks.update.mockImplementation(async (_c: string, change: { instructions?: string; fileIds?: string[] }) => ({
    ...base, ...(change.instructions !== undefined ? { instructions: change.instructions } : {}),
    ...(change.fileIds ? { files: change.fileIds.map(id => ({ id, name: id === 'F1' ? 'spec.md' : 'notes.txt', mime: 'text/plain', size: 1 })) } : {}),
  }));
  mocks.setVerify.mockImplementation(async (_c: string, command: string | null, maxRetries?: number) =>
    ({ ...base, verify: command ? { command, maxRetries: maxRetries ?? 2 } : null }));
});
afterEach(() => { cleanup(); handlers.clear(); Object.values(mocks).forEach(m => m.mockReset()); });

it('saves instructions and pins and unpins files', async () => {
  render(<ProjectPanel />);
  const box = await screen.findByLabelText('Project instructions');
  fireEvent.change(box, { target: { value: 'Use npm. Keep PRs small.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }));
  await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('C1', { instructions: 'Use npm. Keep PRs small.' }));
  expect(await screen.findByText(/Instructions saved/)).toBeTruthy();

  // Only files not pinned yet are offered
  await waitFor(() => expect(screen.getByRole('option', { name: 'notes.txt' })).toBeTruthy());
  expect(screen.queryByRole('option', { name: 'spec.md' })).toBeNull();
  fireEvent.change(screen.getByLabelText('File to pin'), { target: { value: 'F2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Pin' }));
  await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('C1', { fileIds: ['F1', 'F2'] }));
  fireEvent.click(await screen.findByRole('button', { name: 'Unpin spec.md' }));
  await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('C1', { fileIds: ['F2'] }));
});

it('sets and turns off the verify command, refusing shell syntax', async () => {
  render(<ProjectPanel />);
  const cmd = await screen.findByLabelText('Verify command');
  fireEvent.change(cmd, { target: { value: 'npm test && rm -rf /' } });
  expect(screen.getByText(/no quotes, pipes or ;/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Save verify' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(cmd, { target: { value: 'npm run verify' } });
  fireEvent.change(screen.getByLabelText('Fix turns after a failure'), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save verify' }));
  await waitFor(() => expect(mocks.setVerify).toHaveBeenCalledWith('C1', 'npm run verify', 1));
  fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
  await waitFor(() => expect(mocks.setVerify).toHaveBeenCalledWith('C1', null));
});

// beta-test-plan §6.2 "Verify command limits": the UI refuses shell syntax before it reaches the server
it.each([
  ['npm test; rm -rf /'],
  ['npm test && rm -rf /'],
  ['npm test $HOME'],
  ['npm test "--watch"'],
  ["npm test '--watch'"],
  ['npm test | tee out'],
  ['npm  test'],
])('refuses the verify command %j and never saves it', async (value) => {
  render(<ProjectPanel />);
  const cmd = await screen.findByLabelText('Verify command');
  fireEvent.change(cmd, { target: { value } });
  expect(screen.getByText(/no quotes, pipes or ;/)).toBeTruthy();
  const save = screen.getByRole('button', { name: 'Save verify' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.click(save);
  expect(mocks.setVerify).not.toHaveBeenCalled();
});

it('is read-only for members who cannot direct, as plain text', async () => {
  mocks.get.mockResolvedValue({ ...base, instructions: '<img src=x onerror=alert(1)>', canEdit: false, canEditVerify: false,
    verify: { command: 'npm run verify', maxRetries: 2 } });
  const view = render(<ProjectPanel />);
  expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeTruthy();
  expect(view.container.querySelector('img')).toBeNull();
  expect(screen.queryByLabelText('Project instructions')).toBeNull();
  expect(screen.queryByRole('button', { name: /Unpin/ })).toBeNull();
  expect(screen.queryByLabelText('Verify command')).toBeNull();
  expect(screen.getByText('npm run verify')).toBeTruthy();
  expect(mocks.search).not.toHaveBeenCalled();
});

it('follows updates from others without overwriting an unsaved edit', async () => {
  render(<ProjectPanel />);
  const box = await screen.findByLabelText('Project instructions') as HTMLTextAreaElement;
  act(() => handlers.get('ChannelProjectUpdate')!({ ...base, instructions: 'Changed elsewhere', canEdit: undefined }));
  await waitFor(() => expect(box.value).toBe('Changed elsewhere'));
  fireEvent.change(box, { target: { value: 'My draft' } });
  act(() => handlers.get('ChannelProjectUpdate')!({ ...base, instructions: 'Changed again' }));
  expect(box.value).toBe('My draft');
  // Another channel's update is ignored
  act(() => handlers.get('ChannelProjectUpdate')!({ ...base, channelId: 'C2', files: [] }));
  expect(screen.getByText('spec.md')).toBeTruthy();
});
