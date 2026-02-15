interface NewMessagesPillProps {
  count: number;
  onClick: () => void;
}

export function NewMessagesPill({ count, onClick }: NewMessagesPillProps) {
  if (count === 0) return null;

  return (
    <button
      onClick={onClick}
      className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-1.5 bg-primary hover:bg-primary-hover text-text text-sm font-medium rounded-full shadow-lg transition-colors z-10"
    >
      {count} new message{count !== 1 ? 's' : ''}
    </button>
  );
}
