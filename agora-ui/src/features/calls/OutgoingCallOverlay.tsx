import { useCallStore } from '../../stores/callStore';
import { usePalette, hexToRgb } from '../../theme';

export function OutgoingCallOverlay() {
  const P = usePalette();
  const status = useCallStore(s => s.status);
  const direction = useCallStore(s => s.direction);
  const remoteUsername = useCallStore(s => s.remoteUsername);
  const callType = useCallStore(s => s.callType);
  const cancelCall = useCallStore(s => s.cancelCall);

  if (status !== 'ringing' || direction !== 'outgoing') return null;

  const isVideo = callType === 'video';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: `rgba(0, 0, 0, 0.7)`, backdropFilter: 'blur(8px)' }}
    >
      <div
        className="flex flex-col items-center gap-6 p-8 rounded-2xl"
        style={{ background: P.surface, minWidth: '320px' }}
      >
        {/* Pulsing avatar */}
        <div className="relative">
          <div
            className="absolute inset-0 rounded-full animate-ping"
            style={{ background: `rgba(${hexToRgb(P.accent)}, 0.3)` }}
          />
          <div
            className="relative w-20 h-20 rounded-full flex items-center justify-center text-2xl font-bold"
            style={{ background: P.accent, color: '#fff' }}
          >
            {(remoteUsername || '?')[0].toUpperCase()}
          </div>
        </div>

        {/* Calling info */}
        <div className="text-center">
          <div className="text-lg font-semibold" style={{ color: P.text }}>
            {remoteUsername}
          </div>
          <div className="text-sm mt-1" style={{ color: P.muted }}>
            Calling{isVideo ? ' (video)' : ''}...
          </div>
        </div>

        {/* Cancel button */}
        <button
          onClick={cancelCall}
          className="w-14 h-14 rounded-full flex items-center justify-center transition-transform hover:scale-105"
          style={{ background: P.danger }}
          title="Cancel Call"
        >
          <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.68 13.31a16 16 0 003.41 2.6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7 2 2 0 011.72 2v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.42 19.42 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91" />
            <line x1="23" y1="1" x2="1" y2="23" />
          </svg>
        </button>
      </div>
    </div>
  );
}
