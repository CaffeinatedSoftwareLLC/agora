import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { usePalette } from '../../theme';
import { primeAudio } from './voiceStore';
import { useVoiceInput } from './useVoiceInput';

/** A press shorter than this is a tap: recording continues until the next tap. */
const HOLD_MS = 350;

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * Push-to-talk for a composer: hold to talk and release to transcribe, or tap to
 * start and tap again to stop. The text is handed to `onText` for the person to
 * check and send; nothing is sent by itself. Renders nothing where voice input is
 * off or the browser can't record.
 */
export function MicButton({ channelId, onText }: { channelId: string; onText: (text: string) => void }) {
  const P = usePalette();
  const voice = useVoiceInput(channelId, onText);
  const pressRef = useRef<{ at: number; started: boolean } | null>(null);
  const [toggled, setToggled] = useState(false);

  if (!voice.available) return null;

  const recording = voice.state === 'recording';
  const busy = voice.state === 'transcribing';

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || busy) return;
    e.preventDefault();
    primeAudio();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pressRef.current = { at: Date.now(), started: !recording };
    if (!recording) { setToggled(false); void voice.start(); }
  };

  const onPointerUp = () => {
    const press = pressRef.current;
    pressRef.current = null;
    if (!press) return;
    if (!press.started) { setToggled(false); voice.stop(true); return; }   // second tap of tap-to-toggle
    if (Date.now() - press.at < HOLD_MS) setToggled(true);                // a tap: keep recording
    else voice.stop(true);                                                 // released after holding
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Escape' && recording) { e.preventDefault(); setToggled(false); voice.stop(false); return; }
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (e.repeat || busy) return;
    if (recording) { setToggled(false); voice.stop(true); }
    else { primeAudio(); setToggled(true); void voice.start(); }
  };

  const label = recording ? 'Stop recording and transcribe' : busy ? 'Transcribing' : 'Voice input: hold to talk, or tap to start and stop';
  const status = recording
    ? `${clock(voice.elapsed)} / ${clock(voice.maxSeconds)} · ${toggled ? 'Tap the mic to stop, Esc to cancel' : 'Release to transcribe'}`
    : busy ? 'Transcribing…' : voice.error;

  return (
    <div className="relative shrink-0">
      {status && (
        <div
          role={voice.error && !recording && !busy ? 'alert' : 'status'}
          className="absolute bottom-full right-0 mb-2 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs shadow-md max-w-[80vw] overflow-hidden text-ellipsis"
          style={{ background: P.surface, border: `1px solid ${P.border}`, color: voice.error && !recording && !busy ? P.danger : P.text }}
          onClick={voice.error ? voice.clearError : undefined}
        >
          {recording && <span className="inline-block w-2 h-2 rounded-full mr-1.5 animate-pulse" style={{ background: P.danger }} aria-hidden="true" />}
          {status}
        </div>
      )}
      <button
        type="button"
        className="min-h-11 min-w-11 md:min-h-9 md:min-w-9 md:h-9 md:w-9 rounded-xl flex items-center justify-center transition-colors select-none touch-none disabled:cursor-wait"
        style={{
          color: recording ? P.onPrimary : P.muted,
          background: recording ? P.danger : 'transparent',
          WebkitTouchCallout: 'none',
        }}
        title={label}
        aria-label={label}
        aria-pressed={recording}
        disabled={busy}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        onContextMenu={e => e.preventDefault()}
      >
        {busy ? (
          <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path strokeLinecap="round" d="M12 3a9 9 0 109 9" />
          </svg>
        ) : (
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="9" y="2" width="6" height="12" rx="3" />
            <path d="M5 10a7 7 0 0014 0M12 17v5M8 22h8" />
          </svg>
        )}
      </button>
    </div>
  );
}
