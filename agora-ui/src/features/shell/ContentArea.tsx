import { useChannelStore } from '../../stores/channelStore';
import { useServerStore } from '../../stores/serverStore';
import { useUIStore } from '../../stores/uiStore';
import { MessageList } from '../messages/MessageList';
import { MessageInput } from '../messages/MessageInput';

export function ContentArea() {
  const activeChannelId = useChannelStore(s => s.activeChannelId);
  const channels = useChannelStore(s => s.channels);
  const channel = activeChannelId ? channels.get(activeChannelId) : null;
  const activeServerId = useServerStore(s => s.activeServerId);
  const membersOpen = useUIStore(s => s.membersOpen);
  const toggleMembers = useUIStore(s => s.toggleMembers);

  if (!activeChannelId || !channel) {
    return (
      <div className="flex-1 flex items-center justify-center bg-bg">
        <div className="text-center">
          <div className="text-4xl mb-4">Select a channel</div>
          <div className="text-text-muted text-lg">Select a channel to start chatting</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-bg">
      {/* Channel header */}
      <div className="h-12 px-4 flex items-center justify-between border-b border-border shrink-0">
        <div className="flex items-center">
          <span className="text-text-dim mr-2">#</span>
          <span className="font-semibold text-text">{channel.name}</span>
        </div>
        {activeServerId && (
          <button
            onClick={toggleMembers}
            className={`p-1.5 rounded transition-colors ${membersOpen ? 'text-text bg-surface-hover' : 'text-text-muted hover:text-text'}`}
            title="Toggle members"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </button>
        )}
      </div>

      {/* Messages */}
      <MessageList channelId={activeChannelId} channelName={channel.name} />

      {/* Input */}
      <MessageInput key={activeChannelId} channelId={activeChannelId} />
    </div>
  );
}
