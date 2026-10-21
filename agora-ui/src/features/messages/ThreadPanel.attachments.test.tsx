import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import * as apiModule from '../../lib/api';
import { useAuthStore } from '../../stores/authStore';
import { useDraftStore } from '../../stores/draftStore';
import { useMessageStore } from '../../stores/messageStore';
import { useThreadStore } from '../../stores/threadStore';
import { useUploadStore, type PendingUpload } from '../../stores/uploadStore';
import { ThreadPanel } from './ThreadPanel';
import { FloatingMessageInput } from './FloatingMessageInput';

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() }); });
vi.mock('../agents/handoffs', () => ({ useThreadOwner: () => null }));
vi.mock('../voice/MicButton', () => ({ MicButton: () => null }));
vi.mock('../../hooks/useSocket', () => ({ useSocket: () => null }));
const metadata = (id = 'file-1', name = 'note.txt') => ({ id, name, mime: 'text/plain', size: 3, width: null, height: null, url: `/files/${id}` });
const upload = (id: string, threadId?: string): PendingUpload => ({ id, channelId: 'channel', threadId,
  file: new File(['hi'], `${id}.txt`, { type: 'text/plain' }), status: 'done', progress: 100, result: metadata(id, `${id}.txt`) });
beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal('URL', class extends URL { static createObjectURL() { return 'blob:preview'; } static revokeObjectURL() {} });
  vi.spyOn(apiModule, 'uploadFile').mockResolvedValue(metadata());
  vi.spyOn(apiModule.api, 'post').mockResolvedValue({ id: 'reply', attachments: [metadata()] });
  useAuthStore.setState({ user: { id: 'me', username: 'me' } });
  useMessageStore.setState({ byChannel: new Map() });
  useThreadStore.getState().clear();
  useThreadStore.setState({ openThreadId: 'parent', openThreadChannelId: 'channel' });
  useDraftStore.getState().clearAllDrafts();
  useUploadStore.setState({ uploads: new Map() });
});
const send = () => screen.getByRole('button', { name: 'Send reply' }) as HTMLButtonElement;

it('waits for a picked file, then posts an attachment-only reply and clears only its queue', async () => {
  let finish!: (value: ReturnType<typeof metadata>) => void;
  vi.mocked(apiModule.uploadFile).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const channelUpload = upload('channel-only');
  useUploadStore.setState({ uploads: new Map([[channelUpload.id, channelUpload]]) });
  render(<ThreadPanel />);
  const picker = screen.getByLabelText('Thread attachments');
  const click = vi.spyOn(picker as HTMLInputElement, 'click');
  fireEvent.click(screen.getByRole('button', { name: 'Attach file to reply' }));
  expect(click).toHaveBeenCalledOnce();
  fireEvent.change(picker, { target: { files: [new File(['abc'], 'note.txt', { type: 'text/plain' })] } });
  expect(send().disabled).toBe(true);
  fireEvent.keyDown(screen.getByPlaceholderText('Reply...'), { key: 'Enter' });
  expect(apiModule.api.post).not.toHaveBeenCalled();
  await act(async () => { finish(metadata()); });
  expect(send().disabled).toBe(false);
  fireEvent.click(send());
  await waitFor(() => expect(useUploadStore.getState().uploads.size).toBe(1));
  expect(apiModule.api.post).toHaveBeenCalledWith('/channels/channel/messages/parent/replies', { attachments: ['file-1'] });
  expect(useUploadStore.getState().uploads.get('channel-only')).toBe(channelUpload);
  expect(useThreadStore.getState().repliesByThread.get('parent')![0].attachments).toEqual([metadata()]);
});

it('pastes images and drops files into the current thread upload queue', async () => {
  render(<ThreadPanel />);
  const box = screen.getByPlaceholderText('Reply...');
  const image = new File(['image'], 'pasted.png', { type: 'image/png' });
  const note = new File(['note'], 'dropped.txt', { type: 'text/plain' });
  fireEvent.paste(box, { clipboardData: { files: [image] } });
  fireEvent.drop(box, { dataTransfer: { files: [note] } });
  await screen.findByText('pasted.png');
  await screen.findByText('dropped.txt');
  expect(apiModule.uploadFile).toHaveBeenCalledWith('channel', image);
  expect(apiModule.uploadFile).toHaveBeenCalledWith('channel', note);
  expect(useUploadStore.getState().getChannelUploads('channel', 'parent')).toHaveLength(2);
  expect(useUploadStore.getState().getChannelUploads('channel')).toHaveLength(0);
});

it('keeps separate upload drafts when switching threads in the same channel', async () => {
  const a = upload('first', 'parent'), b = upload('second', 'other'), c = upload('channel-only');
  useUploadStore.setState({ uploads: new Map([[a.id, a], [b.id, b], [c.id, c]]) });
  render(<ThreadPanel />);
  expect(screen.queryByText('second.txt')).toBeNull();
  expect(screen.queryByText('channel-only.txt')).toBeNull();
  expect(screen.getByText('first.txt')).toBeTruthy();
  act(() => useThreadStore.setState({ openThreadId: 'other' }));
  expect(screen.queryByText('first.txt')).toBeNull();
  expect(screen.getByText('second.txt')).toBeTruthy();
  act(() => useUploadStore.getState().clearCompleted('channel'));
  expect(useUploadStore.getState().getCompletedIds('channel', 'parent')).toEqual(['first']);
  expect(useUploadStore.getState().getCompletedIds('channel', 'other')).toEqual(['second']);
});

it('does not show thread uploads in the channel composer', () => {
  const thread = upload('thread-only', 'parent'), channel = upload('channel-only');
  useUploadStore.setState({ uploads: new Map([[thread.id, thread], [channel.id, channel]]) });
  render(<FloatingMessageInput channelId="channel" channelName="general" accentColor="#336699" />);
  expect(screen.queryByText('thread-only.txt')).toBeNull();
  expect(screen.getByText('channel-only.txt')).toBeTruthy();
});

it('shows upload failure and requires removal before sending text', async () => {
  vi.mocked(apiModule.uploadFile).mockRejectedValue(new Error('Upload refused'));
  render(<ThreadPanel />);
  fireEvent.change(screen.getByPlaceholderText('Reply...'), { target: { value: 'draft' } });
  fireEvent.change(screen.getByLabelText('Thread attachments'), { target: { files: [new File(['x'], 'bad.txt')] } });
  await screen.findByText('Upload refused');
  expect(send().disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Remove attachment' }));
  expect(send().disabled).toBe(false);
});

it('retains uploads and the text draft if posting fails', async () => {
  vi.mocked(apiModule.api.post).mockRejectedValue(new Error('offline'));
  const a = upload('first', 'parent');
  useUploadStore.setState({ uploads: new Map([[a.id, a]]) });
  render(<ThreadPanel />);
  fireEvent.change(screen.getByPlaceholderText('Reply...'), { target: { value: 'Keep this draft' } });
  fireEvent.click(send());
  await waitFor(() => expect(send().disabled).toBe(false));
  expect(useDraftStore.getState().getDraft('thread:parent')).toBe('Keep this draft');
  expect(useUploadStore.getState().uploads.get(a.id)).toBe(a);
  expect(apiModule.api.post).toHaveBeenCalledWith('/channels/channel/messages/parent/replies', { content: 'Keep this draft', attachments: ['first'] });
});

it('caps picker/drop uploads at ten per thread', async () => {
  const initial = Array.from({ length: 9 }, (_, i) => upload(`ready-${i}`, 'parent'));
  useUploadStore.setState({ uploads: new Map(initial.map(u => [u.id, u])) });
  render(<ThreadPanel />);
  fireEvent.drop(screen.getByPlaceholderText('Reply...'), { dataTransfer: { files: [new File(['1'], 'one'), new File(['2'], 'two')] } });
  await act(async () => {});
  expect(apiModule.uploadFile).toHaveBeenCalledTimes(1);
  expect(useUploadStore.getState().getChannelUploads('channel', 'parent')).toHaveLength(10);
});
