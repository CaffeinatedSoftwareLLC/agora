import { useChannelStore } from '../../stores/channelStore';
import { MessageList } from '../messages/MessageList';
import { MessageInput } from '../messages/MessageInput';

export function ContentArea() {
  const activeChannelId = useChannelStore(s => s.activeChannelId);
  const channels = useChannelStore(s => s.channels);
  const channel = activeChannelId ? channels.get(activeChannelId) : null;

  if (!channel) {
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
      <div className="h-12 px-4 flex items-center border-b border-border shrink-0">
        <span className="text-text-dim mr-2">#</span>
        <span className="font-semibold text-text">{channel.name}</span>
      </div>

      {/* Messages */}
      <MessageList channelId={activeChannelId} channelName={channel.name} />

      {/* Input */}
      <MessageInput channelId={activeChannelId} />
    </div>
  );
}
