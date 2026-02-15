import { useUIStore } from '../../stores/uiStore';

export function ConnectionIndicator() {
  const status = useUIStore(s => s.connectionStatus);
  const colors = {
    connected: 'bg-online',
    reconnecting: 'bg-warn',
    disconnected: 'bg-danger',
  };
  const labels = {
    connected: 'Connected',
    reconnecting: 'Reconnecting...',
    disconnected: 'Disconnected',
  };

  return (
    <div className="relative group">
      <div className={`w-2.5 h-2.5 rounded-full ${colors[status]}`} />
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-surface text-text text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
        {labels[status]}
      </div>
    </div>
  );
}
