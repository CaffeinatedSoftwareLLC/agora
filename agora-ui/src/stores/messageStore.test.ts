import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useMessageStore } from './messageStore';
import type { MessagePayload, MessageUpdatePayload, MessageDeletePayload } from '../lib/contracts/ws-events';

// Mock the API module
vi.mock('../lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { api } from '../lib/api';

const mockApi = vi.mocked(api);

function makePayload(overrides: Partial<MessagePayload> = {}): MessagePayload {
  return {
    id: 'msg-1',
    content: 'hello',
    authorId: 'u1',
    authorUsername: 'alice',
    channelId: 'ch-1',
    createdAt: '2025-01-15T12:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  useMessageStore.setState({ byChannel: new Map(), hasMore: new Map() });
  vi.clearAllMocks();
});

describe('messageStore', () => {
  describe('loadMessages', () => {
    it('loads messages into the store in chronological order', async () => {
      const msgs = [
        makePayload({ id: 'msg-2', createdAt: '2025-01-15T12:01:00.000Z' }),
        makePayload({ id: 'msg-1', createdAt: '2025-01-15T12:00:00.000Z' }),
      ];
      mockApi.get.mockResolvedValueOnce(msgs);

      await useMessageStore.getState().loadMessages('ch-1');

      const stored = useMessageStore.getState().byChannel.get('ch-1')!;
      // API returns newest-first; store reverses to oldest-first
      expect(stored[0].id).toBe('msg-1');
      expect(stored[1].id).toBe('msg-2');
    });

    it('sets hasMore=true when a full page is returned', async () => {
      const msgs = Array.from({ length: 50 }, (_, i) =>
        makePayload({ id: `msg-${i}`, createdAt: new Date(Date.now() - i * 1000).toISOString() })
      );
      mockApi.get.mockResolvedValueOnce(msgs);

      await useMessageStore.getState().loadMessages('ch-1');

      expect(useMessageStore.getState().hasMore.get('ch-1')).toBe(true);
    });

    it('sets hasMore=false when fewer than page size returned', async () => {
      mockApi.get.mockResolvedValueOnce([makePayload()]);

      await useMessageStore.getState().loadMessages('ch-1');

      expect(useMessageStore.getState().hasMore.get('ch-1')).toBe(false);
    });
  });

  describe('loadOlder', () => {
    it('prepends older messages to the channel', async () => {
      // Seed with one existing message
      useMessageStore.setState({
        byChannel: new Map([['ch-1', [{ ...makePayload({ id: 'msg-3' }), pending: undefined, failed: undefined }]]]),
        hasMore: new Map([['ch-1', true]]),
      });

      const older = [
        makePayload({ id: 'msg-2', createdAt: '2025-01-15T11:59:00.000Z' }),
        makePayload({ id: 'msg-1', createdAt: '2025-01-15T11:58:00.000Z' }),
      ];
      mockApi.get.mockResolvedValueOnce(older);

      await useMessageStore.getState().loadOlder('ch-1');

      const stored = useMessageStore.getState().byChannel.get('ch-1')!;
      expect(stored).toHaveLength(3);
      // Older messages prepended in chronological order
      expect(stored[0].id).toBe('msg-1');
      expect(stored[1].id).toBe('msg-2');
      expect(stored[2].id).toBe('msg-3');
    });

    it('does nothing when hasMore is false', async () => {
      useMessageStore.setState({
        byChannel: new Map([['ch-1', [{ ...makePayload(), pending: undefined, failed: undefined }]]]),
        hasMore: new Map([['ch-1', false]]),
      });

      await useMessageStore.getState().loadOlder('ch-1');

      expect(mockApi.get).not.toHaveBeenCalled();
    });
  });

  describe('addMessage (WS handler)', () => {
    it('appends a new message from another user', () => {
      useMessageStore.setState({
        byChannel: new Map([['ch-1', [{ ...makePayload({ id: 'msg-1' }), pending: undefined, failed: undefined }]]]),
        hasMore: new Map(),
      });

      useMessageStore.getState().addMessage(makePayload({ id: 'msg-2' }));

      const stored = useMessageStore.getState().byChannel.get('ch-1')!;
      expect(stored).toHaveLength(2);
      expect(stored[1].id).toBe('msg-2');
    });

    it('confirms an optimistic (pending) message by replacing it', () => {
      const pending = { ...makePayload({ id: 'real-id' }), pending: true, failed: undefined };
      useMessageStore.setState({
        byChannel: new Map([['ch-1', [pending]]]),
        hasMore: new Map(),
      });

      useMessageStore.getState().addMessage(makePayload({ id: 'real-id' }));

      const stored = useMessageStore.getState().byChannel.get('ch-1')!;
      expect(stored).toHaveLength(1);
      expect(stored[0].id).toBe('real-id');
      expect(stored[0].pending).toBeUndefined();
    });

    it('ignores duplicate messages (same id, not pending)', () => {
      const existing = { ...makePayload({ id: 'msg-1' }), pending: undefined, failed: undefined };
      useMessageStore.setState({
        byChannel: new Map([['ch-1', [existing]]]),
        hasMore: new Map(),
      });

      useMessageStore.getState().addMessage(makePayload({ id: 'msg-1' }));

      const stored = useMessageStore.getState().byChannel.get('ch-1')!;
      expect(stored).toHaveLength(1);
    });
  });

  describe('updateMessage (WS handler)', () => {
    it('updates content and editedAt for an existing message', () => {
      useMessageStore.setState({
        byChannel: new Map([['ch-1', [{ ...makePayload({ id: 'msg-1' }), pending: undefined, failed: undefined }]]]),
        hasMore: new Map(),
      });

      const update: MessageUpdatePayload = {
        id: 'msg-1',
        channelId: 'ch-1',
        content: 'edited content',
        editedAt: '2025-01-15T12:05:00.000Z',
      };
      useMessageStore.getState().updateMessage(update);

      const stored = useMessageStore.getState().byChannel.get('ch-1')!;
      expect(stored[0].content).toBe('edited content');
      expect(stored[0].editedAt).toBe('2025-01-15T12:05:00.000Z');
    });

    it('is a no-op if channel has no messages', () => {
      const update: MessageUpdatePayload = {
        id: 'msg-1',
        channelId: 'ch-1',
        content: 'edited',
        editedAt: '2025-01-15T12:05:00.000Z',
      };
      useMessageStore.getState().updateMessage(update);

      expect(useMessageStore.getState().byChannel.get('ch-1')).toBeUndefined();
    });
  });

  describe('removeMessage (WS handler)', () => {
    it('soft-deletes a message (sets content null, adds deletedAt)', () => {
      useMessageStore.setState({
        byChannel: new Map([['ch-1', [{ ...makePayload({ id: 'msg-1' }), pending: undefined, failed: undefined }]]]),
        hasMore: new Map(),
      });

      const del: MessageDeletePayload = {
        id: 'msg-1',
        channelId: 'ch-1',
        deletedAt: '2025-01-15T12:05:00.000Z',
      };
      useMessageStore.getState().removeMessage(del);

      const stored = useMessageStore.getState().byChannel.get('ch-1')!;
      expect(stored[0].content).toBeNull();
      expect(stored[0].deletedAt).toBe('2025-01-15T12:05:00.000Z');
    });
  });

  describe('sendMessage (optimistic)', () => {
    it('adds an optimistic message immediately, then confirms on POST success', async () => {
      useMessageStore.setState({
        byChannel: new Map([['ch-1', []]]),
        hasMore: new Map(),
      });

      mockApi.post.mockResolvedValueOnce({ id: 'real-id' });

      await useMessageStore.getState().sendMessage('ch-1', 'hello', 'u1', 'alice');

      const stored = useMessageStore.getState().byChannel.get('ch-1')!;
      // After POST resolves, the optimistic message is remapped to the real ID
      expect(stored.some(m => m.id === 'real-id')).toBe(true);
    });

    it('marks message as failed on POST error', async () => {
      useMessageStore.setState({
        byChannel: new Map([['ch-1', []]]),
        hasMore: new Map(),
      });

      mockApi.post.mockRejectedValueOnce(new Error('network error'));

      await useMessageStore.getState().sendMessage('ch-1', 'hello', 'u1', 'alice');

      const stored = useMessageStore.getState().byChannel.get('ch-1')!;
      expect(stored).toHaveLength(1);
      expect(stored[0].failed).toBe(true);
      expect(stored[0].pending).toBe(false);
    });
  });

  describe('editMessage (optimistic)', () => {
    it('updates content optimistically, then keeps it on success', async () => {
      useMessageStore.setState({
        byChannel: new Map([['ch-1', [{ ...makePayload({ id: 'msg-1', content: 'original' }), pending: undefined, failed: undefined }]]]),
        hasMore: new Map(),
      });

      mockApi.patch.mockResolvedValueOnce({});

      await useMessageStore.getState().editMessage('ch-1', 'msg-1', 'edited');

      const stored = useMessageStore.getState().byChannel.get('ch-1')!;
      expect(stored[0].content).toBe('edited');
      expect(stored[0].editedAt).toBeDefined();
    });

    it('reverts content on PATCH failure', async () => {
      useMessageStore.setState({
        byChannel: new Map([['ch-1', [{ ...makePayload({ id: 'msg-1', content: 'original' }), pending: undefined, failed: undefined }]]]),
        hasMore: new Map(),
      });

      mockApi.patch.mockRejectedValueOnce(new Error('fail'));

      await useMessageStore.getState().editMessage('ch-1', 'msg-1', 'edited');

      const stored = useMessageStore.getState().byChannel.get('ch-1')!;
      expect(stored[0].content).toBe('original');
      expect(stored[0].editedAt).toBeUndefined();
    });
  });

  describe('deleteMessage (optimistic)', () => {
    it('soft-deletes optimistically, keeps on success', async () => {
      useMessageStore.setState({
        byChannel: new Map([['ch-1', [{ ...makePayload({ id: 'msg-1' }), pending: undefined, failed: undefined }]]]),
        hasMore: new Map(),
      });

      mockApi.delete.mockResolvedValueOnce({});

      await useMessageStore.getState().deleteMessage('ch-1', 'msg-1');

      const stored = useMessageStore.getState().byChannel.get('ch-1')!;
      expect(stored[0].content).toBeNull();
      expect(stored[0].deletedAt).toBeDefined();
    });

    it('reverts on DELETE failure', async () => {
      useMessageStore.setState({
        byChannel: new Map([['ch-1', [{ ...makePayload({ id: 'msg-1', content: 'keep me' }), pending: undefined, failed: undefined }]]]),
        hasMore: new Map(),
      });

      mockApi.delete.mockRejectedValueOnce(new Error('fail'));

      await useMessageStore.getState().deleteMessage('ch-1', 'msg-1');

      const stored = useMessageStore.getState().byChannel.get('ch-1')!;
      expect(stored[0].content).toBe('keep me');
      expect(stored[0].deletedAt).toBeUndefined();
    });
  });

  describe('clear / clearChannel', () => {
    it('clearChannel removes only that channel', () => {
      useMessageStore.setState({
        byChannel: new Map([
          ['ch-1', [{ ...makePayload(), pending: undefined, failed: undefined }]],
          ['ch-2', [{ ...makePayload({ channelId: 'ch-2' }), pending: undefined, failed: undefined }]],
        ]),
        hasMore: new Map([['ch-1', true], ['ch-2', false]]),
      });

      useMessageStore.getState().clearChannel('ch-1');

      expect(useMessageStore.getState().byChannel.has('ch-1')).toBe(false);
      expect(useMessageStore.getState().byChannel.has('ch-2')).toBe(true);
    });

    it('clear removes all channels', () => {
      useMessageStore.setState({
        byChannel: new Map([['ch-1', []], ['ch-2', []]]),
        hasMore: new Map([['ch-1', true]]),
      });

      useMessageStore.getState().clear();

      expect(useMessageStore.getState().byChannel.size).toBe(0);
      expect(useMessageStore.getState().hasMore.size).toBe(0);
    });
  });
});
