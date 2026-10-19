import { usePalette } from '../../theme';
import { SpeakerIcon } from '../messages/MessageActions';
import { useVoiceStore } from './voiceStore';

/** Above the composer while a message is being read: a way to stop it, or why it failed. */
export function ReadingAloud() {
  const P = usePalette();
  const speaking = useVoiceStore(s => s.speaking);
  const error = useVoiceStore(s => s.error);
  const stop = useVoiceStore(s => s.stop);
  if (!speaking && !error) return null;

  return (
    <div className="flex justify-center mb-1.5">
      {speaking ? (
        <button
          type="button"
          onClick={stop}
          className="min-h-9 inline-flex items-center gap-2 rounded-full px-3 text-xs font-medium shadow-md"
          style={{ background: P.surface, border: `1px solid ${P.border}`, color: P.text }}
          aria-label="Stop reading aloud"
        >
          <SpeakerIcon className="w-3.5 h-3.5" />
          Reading aloud · Stop
        </button>
      ) : (
        <button
          type="button"
          role="alert"
          onClick={() => useVoiceStore.setState({ error: null })}
          className="min-h-9 inline-flex items-center rounded-full px-3 text-xs shadow-md"
          style={{ background: P.surface, border: `1px solid ${P.border}`, color: P.danger }}
          title="Dismiss"
        >
          {error}
        </button>
      )}
    </div>
  );
}
