import { beforeEach, expect, it, vi } from 'vitest';
import { sendDraft, useDraftStore } from './draftStore';
import { useMessageStore } from './messageStore';
import { useThreadStore } from './threadStore';
import { useAuthStore } from './authStore';
import { api } from '../lib/api';

vi.hoisted(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
});
beforeEach(() => useDraftStore.getState().clearAllDrafts());
it('isolates channel and thread namespaces and clears one draft', () => {
  const drafts = useDraftStore.getState();
  drafts.setDraft('channel:one', 'channel instruction');
  drafts.setDraft('thread:one', 'reply');
  drafts.setDraft('channel:two', 'another instruction');
  drafts.clearDraft('channel:one');
  expect(drafts.getDraft('channel:one')).toBe('');
  expect(drafts.getDraft('thread:one')).toBe('reply');
  expect(drafts.getDraft('channel:two')).toBe('another instruction');
});
it('keeps failed channel and thread sends and clears successful sends', async () => {
  const drafts = useDraftStore.getState();
  vi.spyOn(api, 'post').mockRejectedValue(new Error('offline'));
  drafts.setDraft('channel:c', 'instruction');
  drafts.setDraft('thread:t', 'reply');
  expect(await sendDraft('channel:c', () => useMessageStore.getState().sendMessage('c', 'instruction', 'u', 'user'))).toBe(false);
  expect(await sendDraft('thread:t', () => useThreadStore.getState().sendReply('c', 't', 'reply', 'u', 'user'))).toBe(false);
  expect(drafts.getDraft('channel:c')).toBe('instruction');
  expect(drafts.getDraft('thread:t')).toBe('reply');
  vi.spyOn(api, 'post').mockResolvedValue({ id: 'sent' });
  await sendDraft('channel:c', () => useMessageStore.getState().sendMessage('c', 'instruction', 'u', 'user'));
  expect(drafts.getDraft('channel:c')).toBe('');
  expect(drafts.getDraft('thread:t')).toBe('reply');
});
it('retains edits and other channel drafts made during a pending request', async () => {
  const drafts = useDraftStore.getState();
  drafts.setDraft('channel:c', 'submitted');
  let accept!: (result: boolean) => void;
  const pending = sendDraft('channel:c', () => new Promise(resolve => { accept = resolve; }));
  drafts.setDraft('channel:c', 'next instruction');
  drafts.setDraft('channel:other', 'other channel');
  accept(true);
  await pending;
  expect(drafts.getDraft('channel:c')).toBe('next instruction');
  expect(drafts.getDraft('channel:other')).toBe('other channel');
});
it('preserves a draft when a send throws and clears all drafts on logout', async () => {
  const drafts = useDraftStore.getState();
  drafts.setDraft('thread:t', 'reply');
  await sendDraft('thread:t', async () => { throw new Error('offline'); });
  expect(drafts.getDraft('thread:t')).toBe('reply');
  useAuthStore.getState().clearSession();
  expect(useDraftStore.getState().drafts).toEqual({});
});
