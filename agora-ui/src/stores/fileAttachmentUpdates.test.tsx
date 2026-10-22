import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useMessageStore, type Message } from './messageStore';
import { useThreadStore } from './threadStore';
import { useFileMetadataStore } from './fileMetadataStore';
import { FileTags } from '../features/messages/FileAttachment';
import type { FileAttachmentUpdatePayload } from '../lib/contracts/ws-events';

vi.hoisted(() => vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() }));
const file = { id: 'file', name: 'notes.pdf', mime: 'application/pdf', size: 100, width: null, height: null, url: '/files/file', tagging: 'pending' as const };
const message: Message = { id: 'message', channelId: 'channel', authorId: 'me', authorUsername: 'me',
  content: 'Notes', createdAt: 'today', editedAt: 'existing edit', attachments: [file, { ...file, id: 'other-file' }],
  protocol: { version: 1, mode: 'fix', state: 'TURN' } };
const update: FileAttachmentUpdatePayload = { channelId: 'channel', messageId: 'message', fileId: 'file',
  tags: ['protocol'], tagging: 'done', partial: true, injectionWarning: true };
beforeEach(() => { useMessageStore.getState().clear(); useThreadStore.getState().clear(); });
afterEach(cleanup);

it.each(['channel', 'thread'])('merges only file metadata in the %s store without changing the message envelope', kind => {
  useMessageStore.setState({ byChannel: new Map([['channel', [message]]]) });
  useThreadStore.setState({ repliesByThread: new Map([['parent', [message]]]) });
  const payload = { ...update, ...(kind === 'thread' ? { threadId: 'parent' } : {}) };
  useMessageStore.getState().updateFileAttachment(payload);
  useThreadStore.getState().updateFileAttachment(payload);
  const held = kind === 'thread' ? useThreadStore.getState().repliesByThread.get('parent')![0] : useMessageStore.getState().byChannel.get('channel')![0];
  expect(held).toMatchObject({ content: 'Notes', editedAt: 'existing edit', protocol: message.protocol });
  expect(held.attachments?.[0]).toEqual({ ...file, tags: ['protocol'], tagging: 'done', partial: true, injectionWarning: true });
  expect(held.attachments?.[1]).toEqual({ ...file, id: 'other-file' });
});

it('updates an open card without remounting and clears old warnings when false arrives', () => {
  render(<FileTags attachment={file} />);
  expect(screen.getByText('tagging…')).toBeTruthy();
  act(() => useMessageStore.getState().updateFileAttachment(update));
  expect(screen.queryByText('tagging…')).toBeNull();
  expect(screen.getByText('protocol')).toBeTruthy();
  expect(screen.getByText(/Contains text that tries to instruct/)).toBeTruthy();
  expect(screen.getByText('(partly read)')).toBeTruthy();
  act(() => useMessageStore.getState().updateFileAttachment({ ...update, tags: [], partial: false, injectionWarning: false }));
  expect(screen.queryByText('protocol')).toBeNull();
  expect(screen.queryByText(/Contains text that tries to instruct/)).toBeNull();
});

it('keeps results that beat the message event or a stale HTTP snapshot, then clears them on logout', () => {
  useThreadStore.getState().updateFileAttachment({ ...update, threadId: 'parent' });
  expect(useThreadStore.getState().repliesByThread.size).toBe(0);
  render(<FileTags attachment={file} />);
  expect(screen.queryByText('tagging…')).toBeNull();
  expect(screen.getByText(/Contains text that tries to instruct/)).toBeTruthy();
  act(() => useMessageStore.getState().clear());
  expect(useFileMetadataStore.getState().byFile.size).toBe(0);
  expect(screen.getByText('tagging…')).toBeTruthy();
});
