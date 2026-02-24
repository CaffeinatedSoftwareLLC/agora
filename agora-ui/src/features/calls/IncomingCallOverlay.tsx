import { useEffect, useRef } from 'react';
import { useCallStore } from '../../stores/callStore';
import { usePalette, hexToRgb } from '../../theme';

export function IncomingCallOverlay() {
  const P = usePalette();
  const incomingCall = useCallStore(s => s.incomingCall);
  const status = useCallStore(s => s.status);
  const direction = useCallStore(s => s.direction);
  const acceptCall = useCallStore(s => s.acceptCall);
  const declineCall = useCallStore(s => s.declineCall);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Only show for incoming ringing calls
  const visible = status === 'ringing' && direction === 'incoming' && incomingCall !== null;

  useEffect(() => {
    if (visible && audioRef.current) {
      audioRef.current.play().catch(() => {});
    }
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      }
    };
  }, [visible]);

  if (!visible || !incomingCall) return null;

  const isVideo = incomingCall.callType === 'video';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: `rgba(0, 0, 0, 0.7)`, backdropFilter: 'blur(8px)' }}
    >
      <audio ref={audioRef} src="/sounds/ring.mp3" loop />
      <div
        className="flex flex-col items-center gap-6 p-8 rounded-2xl"
        style={{ background: P.surface, minWidth: '320px' }}
      >
        {/* Avatar */}
        <div
          className="w-20 h-20 rounded-full flex items-center justify-center text-2xl font-bold animate-pulse"
          style={{ background: P.accent, color: '#fff' }}
        >
          {incomingCall.callerUsername[0].toUpperCase()}
        </div>

        {/* Caller info */}
        <div className="text-center">
          <div className="text-lg font-semibold" style={{ color: P.text }}>
            {incomingCall.callerUsername}
          </div>
          <div className="text-sm mt-1" style={{ color: P.muted }}>
            Incoming {isVideo ? 'video' : 'voice'} call...
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-6">
          <button
            onClick={() => declineCall(incomingCall.callId)}
            className="w-14 h-14 rounded-full flex items-center justify-center transition-transform hover:scale-105"
            style={{ background: P.danger }}
            title="Decline"
          >
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.68 13.31a16 16 0 003.41 2.6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7 2 2 0 011.72 2v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.42 19.42 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91" />
              <line x1="23" y1="1" x2="1" y2="23" />
            </svg>
          </button>

          <button
            onClick={() => acceptCall(incomingCall.callId)}
            className="w-14 h-14 rounded-full flex items-center justify-center transition-transform hover:scale-105"
            style={{ background: P.online }}
            title="Accept"
          >
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
