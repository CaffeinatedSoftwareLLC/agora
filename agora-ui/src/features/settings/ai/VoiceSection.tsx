import { useState } from 'react';
import { voiceApi, ApiError } from '../../../lib/api';
import type { AIVoiceRouteState, AIVoiceView, VoiceEngine } from '../../../lib/api';
import { Button } from '../../../components/ui/Button';
import { inputClass } from './format';

interface Props {
  serverId: string;
  settings: AIVoiceView;
  onChanged: () => void;
}

const ENGINE_TEXT: Record<VoiceEngine, string> = {
  server: 'this server',
  browser: 'each person’s browser',
  off: 'nothing (off)',
};

function routeText(route: AIVoiceRouteState, name: string): string {
  if (!route.configured) return `No ${name} route yet.`;
  return `${name}: ${route.provider} · ${route.model}${route.enabled ? '' : ' (off)'}`;
}

/**
 * Voice in and out (docs/voice.md). The engines are the Transcription (`stt`) and
 * Speech (`tts`) capability routes above; this section switches voice input and
 * read-aloud on or off and decides when people's browsers may stand in.
 */
export function VoiceSection({ serverId, settings, onChanged }: Props) {
  const [inputOn, setInputOn] = useState(settings.voiceInputEnabled);
  const [browserStt, setBrowserStt] = useState(settings.browserSttFallback);
  const [seconds, setSeconds] = useState(String(settings.maxRecordingSeconds));
  const [language, setLanguage] = useState(settings.sttLanguage ?? '');
  const [readOn, setReadOn] = useState(settings.readAloudEnabled);
  const [readServer, setReadServer] = useState(settings.readAloudServer);
  const [browserTts, setBrowserTts] = useState(settings.browserTtsFallback);
  const [voice, setVoice] = useState(settings.readAloudVoice ?? '');
  const [maxChars, setMaxChars] = useState(String(settings.readAloudMaxChars));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    const secs = Number(seconds);
    const chars = Number(maxChars);
    if (!Number.isInteger(secs) || secs < 5 || secs > 600) { setError('The longest recording must be 5 to 600 seconds.'); return; }
    if (!Number.isInteger(chars) || chars < 100 || chars > 4000) { setError('The longest text read aloud must be 100 to 4000 characters.'); return; }
    const lang = language.trim();
    if (lang && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(lang)) { setError('Language must be a code such as en or pt-BR, or blank to detect it.'); return; }
    const voiceName = voice.trim();
    if (voiceName && !/^[A-Za-z0-9_.:+-]{1,64}$/.test(voiceName)) { setError('Voice must be a voice name such as af_heart, alloy or Kore.'); return; }

    setSaving(true);
    setError('');
    try {
      await voiceApi.patchSettings(serverId, {
        voiceInputEnabled: inputOn,
        browserSttFallback: browserStt,
        maxRecordingSeconds: secs,
        sttLanguage: lang || null,
        readAloudEnabled: readOn,
        readAloudServer: readServer,
        browserTtsFallback: browserTts,
        readAloudVoice: voiceName || null,
        readAloudMaxChars: chars,
      });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? (err.message || err.code) : 'Failed to save');
      setSaving(false);
    }
  }

  return (
    <section className="mb-10">
      <h3 className="text-lg font-semibold text-text mb-2">Voice</h3>
      <p className="text-sm text-text-muted mb-3">
        A push-to-talk microphone in the message box, and agent replies read aloud. Free and offline works best:
        a local faster-whisper server for Transcription and a local Kokoro server for Speech, both added above as
        OpenAI-compatible providers. Each person turns automatic read-aloud on in Account &amp; security.
      </p>
      <p className="text-sm text-text-muted mb-3">
        Now: voice input uses {ENGINE_TEXT[settings.engines.input]}; read-aloud uses {ENGINE_TEXT[settings.engines.output]}.
      </p>

      {settings.warnings.map(w => (
        <p key={w} className="text-sm text-warn border border-border rounded px-3 py-2 mb-3">{w}</p>
      ))}

      <div className="flex flex-col gap-2">
        <div className="border border-border rounded-lg px-4 py-3">
          <Check checked={inputOn} onChange={setInputOn} label="Voice input" description={routeText(settings.routes.stt, 'Transcription')} />
          <div className="ml-7 mt-2 flex flex-col gap-2">
            <Check
              checked={browserStt}
              onChange={setBrowserStt}
              label="Without a Transcription route, let browsers recognise speech"
              description="Chrome sends the audio to Google and Safari to Apple for recognition; Firefox has none. Off keeps audio on your own servers."
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Longest recording (seconds)" value={seconds} onChange={setSeconds} placeholder="120" numeric />
              <Field label="Language (blank: detect)" value={language} onChange={setLanguage} placeholder="en" />
            </div>
          </div>
        </div>

        <div className="border border-border rounded-lg px-4 py-3">
          <Check checked={readOn} onChange={setReadOn} label="Read-aloud" description="A Read aloud action on messages, and automatic reading for people who turn it on." />
          <div className="ml-7 mt-2 flex flex-col gap-2">
            <Check
              checked={readServer}
              onChange={setReadServer}
              label="Use this server’s Speech route"
              description={`${routeText(settings.routes.tts, 'Speech')} Every reply read this way is a Speech request (it counts toward that route’s daily limits; a repeat of the same reply is served from memory).`}
            />
            <Check
              checked={browserTts}
              onChange={setBrowserTts}
              label="Otherwise use the browser’s own voices"
              description="On-device voices where the browser has them. Quality varies by phone and computer."
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Voice for the Speech route" value={voice} onChange={setVoice} placeholder="af_heart, alloy, Kore…" />
              <Field label="Longest text read per message (characters)" value={maxChars} onChange={setMaxChars} placeholder="1500" numeric />
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 mt-3">
        <Button onClick={save} loading={saving}>Save</Button>
      </div>
      {error && <p className="text-danger text-sm mt-2">{error}</p>}
    </section>
  );
}

function Check({ checked, onChange, label, description }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description: string;
}) {
  return (
    <label className="min-h-11 flex items-start gap-3 cursor-pointer">
      <input type="checkbox" className="accent-primary mt-1" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span>
        <span className="text-text font-medium text-sm">{label}</span>
        <span className="block text-xs text-text-muted">{description}</span>
      </span>
    </label>
  );
}

function Field({ label, value, onChange, placeholder, numeric }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  numeric?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-text-muted">
      {label}
      <input
        className={`${inputClass} py-1 text-sm`}
        inputMode={numeric ? 'numeric' : undefined}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}
