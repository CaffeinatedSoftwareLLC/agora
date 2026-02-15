interface EmptyChannelProps {
  channelName: string;
}

export function EmptyChannel({ channelName }: EmptyChannelProps) {
  return (
    <div className="flex-1 flex items-end justify-center pb-4">
      <div className="text-center px-4">
        <div className="text-2xl font-bold text-text mb-2">
          Welcome to #{channelName}
        </div>
        <div className="text-text-muted text-sm">
          This is the very beginning of the <strong>#{channelName}</strong> channel.
        </div>
      </div>
    </div>
  );
}
