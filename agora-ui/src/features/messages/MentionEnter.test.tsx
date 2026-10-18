import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { flushSync } from 'react-dom';
import { useAuthStore } from '../../stores/authStore';
import { useDraftStore } from '../../stores/draftStore';
import { useMemberStore } from '../../stores/memberStore';
import { useMessageStore } from '../../stores/messageStore';
import { useServerStore } from '../../stores/serverStore';
import { FloatingMessageInput } from './FloatingMessageInput';
import { MessageInput } from './MessageInput';

vi.hoisted(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
});

const socket = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn() }));
vi.mock('../../hooks/useSocket', () => ({ useSocket: () => socket }));

const CH = 'C'.repeat(26);
const SRV = 'S'.repeat(26);
const sendMessage = vi.fn();

// A real keypress gets a microtask checkpoint between listeners, so React commits the
// autocomplete's state change (list closed) before the composer's onKeyDown runs. A
// synthetic dispatchEvent does not, which hid the bug. Flushing between the document
// capture listener and the target reproduces the browser order.
const flushBetweenListeners = () => { flushSync(() => {}); };
beforeEach(() => document.body.addEventListener('keydown', flushBetweenListeners, true));
afterEach(() => document.body.removeEventListener('keydown', flushBetweenListeners, true));

beforeEach(() => {
  sendMessage.mockReset();
  sendMessage.mockResolvedValue(true);
  useMessageStore.setState({ sendMessage } as never);
  useAuthStore.setState({ user: { id: 'U1', username: 'eryk' } } as never);
  useServerStore.setState({ activeServerId: SRV } as never);
  useMemberStore.setState({
    byServer: new Map([[SRV, [{ id: 'B1', username: 'AI-Assistant', joinedAt: '', roles: [] }]]]),
  });
  useDraftStore.getState().clearDraft(`channel:${CH}`);
});

const composers = [
  ['FloatingMessageInput', () => <FloatingMessageInput channelId={CH} accentColor="#336699" />],
  ['MessageInput', () => <MessageInput channelId={CH} />],
] as const;

describe.each(composers)('%s with the mention list open (#17)', (_name, Composer) => {
  it('Enter picks the mention and does not send', async () => {
    render(<Composer />);
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '@AI', selectionStart: 3 } });
    await screen.findByRole('button', { name: /AI-Assistant/ });

    fireEvent.keyDown(box, { key: 'Enter' });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(useDraftStore.getState().getDraft(`channel:${CH}`)).toBe('@AI-Assistant ');
    expect(screen.queryByRole('button', { name: /AI-Assistant/ })).toBeNull();
  });

  it('a second Enter, with the list closed, sends', async () => {
    render(<Composer />);
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '@AI', selectionStart: 3 } });
    await screen.findByRole('button', { name: /AI-Assistant/ });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.keyDown(box, { key: 'Enter' });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage.mock.calls[0][1]).toBe('@AI-Assistant');
  });
});
