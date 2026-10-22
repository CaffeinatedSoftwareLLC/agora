import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { useAuthStore } from '../../stores/authStore';
import { useChannelStore } from '../../stores/channelStore';
import { useMemberStore } from '../../stores/memberStore';
import { useMessageStore } from '../../stores/messageStore';
import { useThreadStore } from '../../stores/threadStore';
import { Avatar } from './Avatar';
import { ChannelAvatars } from './ChannelAvatars';

afterEach(cleanup);

it('shares eight bot colours across feed, thread, roster and autocomplete, including after a rename', () => {
  const members = Array.from({ length: 8 }, (_, i) => ({ id: `bot-${i}`, username: `Bot ${i}`, joinedAt: '', roles: [] }));
  useAuthStore.setState({ user: { id: 'owner', username: 'Owner' } });
  useChannelStore.setState({ activeChannelId: 'channel', channels: new Map([['channel', { id: 'channel', name: 'general', channelType: 3, serverId: 'server' }]]) });
  useMemberStore.setState({ byServer: new Map([['server', members]]) });
  useMessageStore.setState({ byChannel: new Map() });
  useThreadStore.setState({ repliesByThread: new Map(), activeThreads: new Map() });
  const view = render(<ChannelAvatars>{['feed', 'thread', 'roster', 'autocomplete'].map(name =>
    <div key={name} data-testid={name}>{members.map(member => <Avatar key={member.id} userId={member.id} username={member.username} />)}</div>
  )}</ChannelAvatars>);
  const feed = view.getByTestId('feed').querySelectorAll<HTMLElement>('[data-avatar-user]');
  expect(new Set(Array.from(feed, el => el.style.backgroundColor)).size).toBe(8);
  const expected = new Map(Array.from(feed, el => [el.dataset.avatarUser, el.style.backgroundColor]));
  for (const el of view.container.querySelectorAll<HTMLElement>('[data-avatar-user]')) expect(el.style.backgroundColor).toBe(expected.get(el.dataset.avatarUser));
  act(() => useMemberStore.setState({ byServer: new Map([['server', members.map(m => ({ ...m, username: 'Renamed' })).reverse()]]) }));
  for (const el of view.container.querySelectorAll<HTMLElement>('[data-avatar-user]')) expect(el.style.backgroundColor).toBe(expected.get(el.dataset.avatarUser));
});
