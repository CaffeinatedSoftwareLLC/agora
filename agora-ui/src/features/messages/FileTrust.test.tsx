import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { useAuthStore } from '../../stores/authStore';
import { useMessageStore } from '../../stores/messageStore';
import { useUIStore } from '../../stores/uiStore';
import { clearViewerAuthority } from '../agents/viewerAuthority';
import { FileTags } from './FileAttachment';

vi.hoisted(() => vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() }));
const directors = { directors: [{ userId: 'owner', authority: 'owner' }, { userId: 'director', authority: 'director' }] };
const attachment = { id: 'file', tags: ['protocol'], injectionWarning: true };
const update = { fileId: 'file', channelId: 'channel', messageId: 'message', tags: ['protocol'], tagging: 'done',
  partial: false, injectionWarning: false, trustedByOwner: true, trustedBy: 'owner', trustedAt: '2026-10-22T12:00:00Z' };
beforeEach(() => {
  vi.restoreAllMocks(); clearViewerAuthority(); useMessageStore.getState().clear();
  useAuthStore.setState({ user: { id: 'owner', username: 'owner' } });
  useUIStore.setState({ activeOverlay: null });
  vi.spyOn(api, 'get').mockResolvedValue(directors);
});
afterEach(cleanup);

it('requires owner confirmation, updates the label, and lets the owner undo', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue(update);
  const undo = vi.spyOn(api, 'delete').mockResolvedValue({ ...update, trustedByOwner: false, trustedBy: null, trustedAt: null, injectionWarning: true });
  render(<FileTags attachment={attachment} channelId="channel" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Mark as trusted' }));
  expect(screen.getByRole('dialog', { name: 'Trust this file?' })).toBeTruthy();
  expect(screen.getByText(/Agents will no longer be warned about this file/)).toBeTruthy();
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Mark as trusted' }));
  fireEvent.click(screen.getByRole('button', { name: 'Trust file' }));
  await screen.findByText('✓ Trusted by owner');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.queryByText(/Contains text that tries/)).toBeNull();
  expect(post).toHaveBeenCalledWith('/files/file/trust', {});
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  await screen.findByText(/Contains text that tries/);
  expect(screen.queryByText('✓ Trusted by owner')).toBeNull();
  expect(undo).toHaveBeenCalledWith('/files/file/trust');
});

it.each(['director', 'member', 'bot'])('%s sees trust labels and warnings but no trust controls', async userId => {
  useAuthStore.setState({ user: { id: userId, username: userId } });
  const view = render(<FileTags attachment={attachment} channelId="channel" />);
  await act(async () => {});
  expect(screen.queryByRole('button', { name: 'Mark as trusted' })).toBeNull();
  view.rerender(<FileTags attachment={{ ...attachment, trustedByOwner: true, injectionWarning: false }} channelId="channel" />);
  expect(screen.getByText('✓ Trusted by owner')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
});

it('keeps the warning and shows the error in the confirmation when the API denies trust', async () => {
  vi.spyOn(api, 'post').mockRejectedValue(new Error('403'));
  render(<FileTags attachment={attachment} channelId="channel" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Mark as trusted' }));
  fireEvent.click(screen.getByRole('button', { name: 'Trust file' }));
  expect((await screen.findByRole('alert')).closest('[role="dialog"]')).toBeTruthy();
  expect(screen.queryByText('✓ Trusted by owner')).toBeNull();
});

it('does not expose controls when the ownership lookup fails', async () => {
  vi.mocked(api.get).mockRejectedValue(new Error('offline'));
  render(<FileTags attachment={attachment} channelId="channel" />);
  await act(async () => {});
  expect(screen.queryByRole('button', { name: 'Mark as trusted' })).toBeNull();
});
