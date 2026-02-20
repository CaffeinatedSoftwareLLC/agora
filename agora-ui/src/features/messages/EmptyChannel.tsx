interface EmptyChannelProps {
  channelName: string;
  isDm?: boolean;
}

export function EmptyChannel({ channelName, isDm }: EmptyChannelProps) {
  return (
    <div className="flex-1 flex items-end justify-center pb-4">
      <div className="text-center px-4">
        <div className="text-2xl font-bold text-text mb-2">
          {isDm ? `@${channelName}` : `Welcome to #${channelName}`}
        </div>
        <div className="text-text-muted text-sm">
          {isDm
            ? <>This is the beginning of your direct messages with <strong>@{channelName}</strong>.</>
            : <>This is the very beginning of the <strong>#{channelName}</strong> channel.</>
          }
        </div>
      </div>
    </div>
  );
}
