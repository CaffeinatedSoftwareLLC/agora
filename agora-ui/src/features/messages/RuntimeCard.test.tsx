import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useMessageStore, type Message } from '../../stores/messageStore';
import { RuntimeCard } from './RuntimeCard';

vi.hoisted(() => vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() }));

const CH = 'C'.repeat(26);
const RUN = 'R'.repeat(26);
const card: Message = {
  id: 'M'.repeat(26), channelId: CH, content: `A bot wants to run code (run ${RUN}).`, authorId: '', authorUsername: '',
  createdAt: '2026-11-05T10:00:00.000Z', systemEvent: 'runtime_approval',
  systemData: { kind: 'runtime_approval', runId: RUN, status: 'pending', capabilities: [] },
};

function Live() {
  const message = useMessageStore(s => s.byChannel.get(CH)?.[0]);
  return message ? <RuntimeCard message={message} /> : null;
}

beforeEach(() => {
  useMessageStore.getState().clear();
  useMessageStore.setState({ byChannel: new Map([[CH, [card]]]) });
});
afterEach(cleanup);

it('a card denied by an account change switches from pending to denied live and offers no Approve (#244)', () => {
  render(<Live />);
  expect(screen.getByText('PENDING')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();

  // The MessageUpdate the server emits after the suspension commits (src/lib/run-cards.ts)
  act(() => useMessageStore.getState().updateMessage({
    id: card.id, channelId: CH, editedAt: '2026-11-05T10:01:00.000Z',
    content: `Run ${RUN}: Denied. The submitting bot or its owner was suspended.`,
    systemData: { ...card.systemData, status: 'denied', deniedReason: 'The submitting bot or its owner was suspended' },
  }));

  expect(screen.getByText('DENIED')).toBeTruthy();
  expect(screen.queryByText('PENDING')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
  expect(screen.getByText(/The submitting bot or its owner was suspended/)).toBeTruthy();
});
