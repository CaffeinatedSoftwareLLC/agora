import { useEffect } from 'react';
import { useUIStore } from '../../stores/uiStore';
import { isPhoneLike, primeAudio, useVoiceStore, type ReadAloudPref } from './voiceStore';

const OPTIONS: { value: ReadAloudPref; label: string; description: string }[] = [
  { value: 'off', label: 'Off', description: 'Use Read aloud on a message when you want to hear it.' },
  { value: 'phone', label: 'On my phone', description: 'New agent replies in the channel or thread you have open are read aloud on touch-screen devices.' },
  { value: 'all', label: 'On every device', description: 'The same, on computers too.' },
];

/** Settings → Account: read agents' new replies aloud (saved to the account, so every device knows). */
export function ReadAloudSettings() {
  const readAloud = useVoiceStore(s => s.readAloud);
  const setReadAloud = useVoiceStore(s => s.setReadAloud);
  // This page sits outside the app shell, which loads preferences on connect
  useEffect(() => { void useUIStore.getState().loadPreferences(); }, []);

  return (
    <section aria-labelledby="read-aloud-heading" className="flex flex-col gap-4">
      <div>
        <h2 id="read-aloud-heading" className="text-lg font-semibold">Read replies aloud</h2>
        <p className="text-sm text-text-muted mt-1">
          Hear what your agents say while you are away from the screen. The server’s admin chooses the voice;
          the microphone button in the message box turns your speech into text you can check before sending.
          {isPhoneLike() ? ' This device counts as a phone.' : ''}
        </p>
      </div>
      <div role="radiogroup" aria-labelledby="read-aloud-heading" className="flex flex-col gap-1">
        {OPTIONS.map(o => (
          <label key={o.value} className="min-h-11 flex items-start gap-3 cursor-pointer">
            <input
              type="radio"
              name="read-aloud"
              className="accent-primary mt-1"
              checked={readAloud === o.value}
              // The tap that turns it on also lets this browser play sound later
              onChange={() => { primeAudio(); setReadAloud(o.value); }}
            />
            <span>
              <span className="text-sm font-medium text-text">{o.label}</span>
              <span className="block text-xs text-text-muted">{o.description}</span>
            </span>
          </label>
        ))}
      </div>
    </section>
  );
}
