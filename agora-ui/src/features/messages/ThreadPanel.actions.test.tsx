import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { api } from '../../lib/api';
import { useAuthStore } from '../../stores/authStore';
import { useMessageStore, type Message } from '../../stores/messageStore';
import { useThreadStore } from '../../stores/threadStore';
import { useUIStore } from '../../stores/uiStore';
import { ThreadPanel } from './ThreadPanel';

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() }); });
vi.mock('../agents/handoffs', () => ({ useThreadOwner: () => null }));
vi.mock('../voice/MicButton', () => ({ MicButton: () => null }));

const reply: Message = {
  id: 'reply', channelId: 'channel', content: 'Original reply', authorId: 'me',
  authorUsername: 'me', createdAt: '2026-10-21T12:00:00Z',
};
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'patch').mockResolvedValue({});
  vi.spyOn(api, 'delete').mockResolvedValue({});
  useAuthStore.setState({ user: { id: 'me', username: 'me' } });
  useMessageStore.setState({ byChannel: new Map([['channel', [{ ...reply, id: 'parent', content: 'Parent' }]]]) });
  useThreadStore.getState().clear();
  useThreadStore.setState({ openThreadId: 'parent', openThreadChannelId: 'channel', repliesByThread: new Map([['parent', [reply]]]) });
  useUIStore.setState({ activeOverlay: null });
});

describe.each(['desktop', 'phone'] as const)('thread reply actions: %s', mode => {
  async function action(name: 'Edit' | 'Delete') {
    if (mode === 'phone') {
      fireEvent.click(screen.getByRole('button', { name: 'Message actions' }));
      const sheet = await screen.findByRole('dialog', { name: 'Message actions' });
      fireEvent.click(within(sheet).getByRole('button', { name: `${name} message` }));
    } else fireEvent.click(screen.getByRole('button', { name }));
  }

  it('saves an edited own reply and deletes it through real store handlers', async () => {
    render(<ThreadPanel />);
    await action('Edit');
    const editor = screen.getByDisplayValue('Original reply');
    fireEvent.change(editor, { target: { value: 'Edited reply' } });
    fireEvent.keyDown(editor, { key: 'Enter' });
    await screen.findByText('Edited reply');
    expect(api.patch).toHaveBeenCalledWith('/channels/channel/messages/reply', { content: 'Edited reply' });
    await action('Delete');
    await screen.findByText('[message deleted]');
    expect(api.delete).toHaveBeenCalledWith('/channels/channel/messages/reply');
    expect(useMessageStore.getState().byChannel.get('channel')![0].content).toBe('Parent');
  });

  it('does not offer edit/delete for another author\'s reply', async () => {
    useThreadStore.setState({ repliesByThread: new Map([['parent', [{ ...reply, authorId: 'other' }]]]) });
    render(<ThreadPanel />);
    if (mode === 'phone') {
      fireEvent.click(screen.getByRole('button', { name: 'Message actions' }));
      const sheet = await screen.findByRole('dialog', { name: 'Message actions' });
      expect(within(sheet).queryByRole('button', { name: 'Edit message' })).toBeNull();
      expect(within(sheet).queryByRole('button', { name: 'Delete message' })).toBeNull();
    } else {
      expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    }
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });
});
